// import_from_excel.cjs
require('dotenv').config()

const path = require('path')
const postgres = require('postgres')
const xlsx = require('xlsx')

// ------------------------
// Conexión a Neon
// ------------------------
const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : undefined,
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  prepare: false // <- importante para evitar "cached plan must not change result type"
})

const many = async (q) => q
const one = async (q) => {
  const rows = await q
  return rows[0] || null
}

// ------------------------
// Helpers
// ------------------------
function normalizePlate(plate) {
  if (plate === null || plate === undefined) return null
  let s = String(plate).trim()
  if (!s || s === '-' || s === '--') return null
  return s.toUpperCase().replace(/\s+/g, '')
}

function extractBrandModelYear(value) {
  if (!value) return { brand: null, model: null, year: null }

  const str = String(value).trim()
  if (!str) return { brand: null, model: null, year: null }

  const parts = str.split(/\s+/)
  const brand = parts[0] || null
  const model = parts.slice(1).join(' ') || null

  // Busca año tipo 1950–2049
  const matchYear = str.match(/(19[5-9]\d|20[0-4]\d)/)
  const year = matchYear ? Number(matchYear[0]) : null

  return { brand, model, year }
}

// ✅ Versión robusta: Date, número de Excel o string dd/mm/yyyy
function toDateOnly(value) {
  if (!value) return null

  let d

  // 1) Ya es Date
  if (value instanceof Date) {
    d = value
  } else if (typeof value === 'number') {
    // 2) Número "serial" de Excel (días desde 1899-12-30)
    const excelEpoch = Date.UTC(1899, 11, 30) // 1899-12-30
    const ms = excelEpoch + value * 24 * 60 * 60 * 1000
    d = new Date(ms)
  } else if (typeof value === 'string') {
    const str = value.trim()
    if (!str) return null

    // 3) Formato dd/mm/yyyy (25/10/2024)
    const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (m) {
      const day = Number(m[1])
      const month = Number(m[2]) - 1
      const year = Number(m[3])
      d = new Date(year, month, day)
    } else {
      // 4) Último intento: que JS lo entienda solo
      d = new Date(str)
    }
  } else {
    d = new Date(value)
  }

  if (isNaN(d.getTime())) return null

  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function cleanPhone(raw) {
  if (raw === null || raw === undefined) return null
  let s = String(raw).trim()
  if (!s) return null
  return s.replace(/\s+/g, '')
}

// Armo un resumen general para el campo summary
function buildSummary(row) {
  const parts = []

  if (row['Aceite']) parts.push(`Aceite: ${row['Aceite']}`)
  if (row['Filtro de aceite']) parts.push(`Filtro aceite: ${row['Filtro de aceite']}`)
  if (row['Filtro de Aire']) parts.push(`Filtro aire: ${row['Filtro de Aire']}`)
  if (row['Filtro de combustible']) parts.push(`Filtro combustible: ${row['Filtro de combustible']}`)
  if (row['Filtro de habitáculo']) parts.push(`Filtro habitáculo: ${row['Filtro de habitáculo']}`)
  if (row['Otros servicios']) parts.push(`Otros: ${row['Otros servicios']}`)
  if (row['Precio Final Del Cambio'] != null && row['Precio Final Del Cambio'] !== '') {
    parts.push(`Precio: ${row['Precio Final Del Cambio']}`)
  }

  return parts.join(' | ') || null
}

// ------------------------
// Upsert de Client
// ------------------------
async function upsertClient(nameRaw, phoneRaw, emailRaw) {
  const name = nameRaw ? String(nameRaw).trim() : null
  const phone = cleanPhone(phoneRaw)
  const email = emailRaw ? String(emailRaw).trim() : null

  let client = null

  if (phone) {
    client = await one(sql`SELECT * FROM "Client" WHERE "phone" = ${phone} LIMIT 1`)
  }

  if (!client && email) {
    client = await one(sql`SELECT * FROM "Client" WHERE "email" = ${email} LIMIT 1`)
  }

  if (!client && name) {
    client = await one(sql`SELECT * FROM "Client" WHERE "name" = ${name} LIMIT 1`)
  }

  if (client) {
    const newPhone = client.phone || phone
    const newEmail = client.email || email

    if (newPhone !== client.phone || newEmail !== client.email) {
      client = await one(sql`
        UPDATE "Client"
        SET "phone"     = ${newPhone},
            "email"     = ${newEmail},
            "updatedAt" = NOW()
        WHERE id = ${client.id}
        RETURNING *`)
    }

    return client
  }

  if (!name && !phone && !email) {
    return null
  }

  const inserted = await one(sql`
    INSERT INTO "Client"
      ("name", "phone", "email", "createdAt", "updatedAt")
    VALUES (
      ${name || null},
      ${phone || null},
      ${email || null},
      NOW(),
      NOW()
    )
    RETURNING *`)

  return inserted
}

// ------------------------
// Upsert de Vehicle
// ------------------------
async function upsertVehicle(plate, brandModelYear, client) {
  if (!plate) return null

  const { brand, model, year } = extractBrandModelYear(brandModelYear)

  let vehicle = await one(sql`
    SELECT * FROM "Vehicle"
    WHERE "plate" = ${plate}
    LIMIT 1`)

  if (vehicle) {
    let newClientId = vehicle.clientId
    if (!newClientId && client?.id) {
      newClientId = client.id
    }

    if (newClientId !== vehicle.clientId) {
      vehicle = await one(sql`
        UPDATE "Vehicle"
        SET "clientId"  = ${newClientId},
            "updatedAt" = NOW()
        WHERE "plate" = ${plate}
        RETURNING *`)
    }

    return vehicle
  }

  const inserted = await one(sql`
    INSERT INTO "Vehicle"
      ("plate", "clientId", "brand", "model", "year", "createdAt", "updatedAt")
    VALUES (
      ${plate},
      ${client?.id || null},
      ${brand},
      ${model},
      ${year},
      NOW(),
      NOW()
    )
    RETURNING *`)

  return inserted
}

// ------------------------
// Insert de Service
// ------------------------
async function insertService(plate, client, row) {
  // 👉 Regla: primero "Fecha"; si está vacía, "Marca temporal"
  const date =
    toDateOnly(row['Fecha']) ||
    toDateOnly(row['Marca temporal']) ||
    null

  const odometer =
    row['Cantidad de Kilómetros'] != null && row['Cantidad de Kilómetros'] !== ''
      ? Number(String(row['Cantidad de Kilómetros']).replace(/\./g, '').replace(',', '.'))
      : null

  const summary = buildSummary(row)

  const oil = row['Aceite'] || null
  const filterOil = row['Filtro de aceite'] || null
  const filterAir = row['Filtro de Aire'] || null
  const filterFuel = row['Filtro de combustible'] || null
  const filterCabin = row['Filtro de habitáculo'] || null
  const otherServices = row['Otros servicios'] || null

  let totalPrice = null
  if (row['Precio Final Del Cambio'] != null && row['Precio Final Del Cambio'] !== '') {
    const rawPrice = String(row['Precio Final Del Cambio']).trim()
    const normalizedPrice = rawPrice.replace(/\./g, '').replace(',', '.')
    const parsed = Number(normalizedPrice)
    totalPrice = isNaN(parsed) ? null : parsed
  }

  if (!date) {
    console.warn(`Fila sin fecha válida, se salta (patente: ${plate || 'sin patente'})`)
    return
  }

  await one(sql`
    INSERT INTO "Service"
      ("vehicleId", "clientId", "date", "odometer",
       "summary",
       "oil", "filterOil", "filterAir", "filterFuel", "filterCabin",
       "otherServices", "totalPrice",
       "createdAt", "updatedAt")
    VALUES (
      ${plate},
      ${client?.id || null},
      ${date},
      ${odometer},
      ${summary},
      ${oil}, ${filterOil}, ${filterAir}, ${filterFuel}, ${filterCabin},
      ${otherServices}, ${totalPrice},
      NOW(), NOW()
    )
    RETURNING *`)
}

// ------------------------
// MAIN
// ------------------------
async function main() {
  const filePath = path.join(__dirname, 'Datos de contacto (respuestas).xlsx')
  console.log('Leyendo archivo:', filePath)

  const workbook = xlsx.readFile(filePath)
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]

  const rows = xlsx.utils.sheet_to_json(sheet, {
    defval: '',
    cellDates: true, // 👉 devuelve Date cuando la celda es fecha
    raw: false       // 👉 intenta parsear los valores (incluye fechas)
  })
  console.log(`Filas leídas: ${rows.length}`)

  let imported = 0
  let skippedNoPlate = 0

  for (const [idx, row] of rows.entries()) {
    try {
      const plate = normalizePlate(row['Patente del vehículo'])
      const name = row['Nombre y Apellido']
      const phone = row['WhatsApp']
      const email =
        row['Dirección de correo electrónico'] ||
        row['Gmail'] ||
        null

      if (!plate) {
        skippedNoPlate++
        console.warn(`Fila ${idx + 2}: sin patente válida, se salta`)
        continue
      }

      const client = await upsertClient(name, phone, email)
      await upsertVehicle(plate, row['Marca, modelo y año del vehiculo'], client)
      await insertService(plate, client, row)

      imported++
      if (imported % 10 === 0) {
        console.log(`Importados ${imported} servicios...`)
      }
    } catch (err) {
      console.error(`Error en fila ${idx + 2}:`, err.message)
    }
  }

  console.log('\nImportación terminada.')
  console.log(`Servicios importados: ${imported}`)
  console.log(`Filas saltadas por falta de patente: ${skippedNoPlate}`)

  await sql.end()
}

main().catch((err) => {
  console.error(err)
  sql.end()
})
