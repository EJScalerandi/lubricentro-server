// server.js
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const postgres = require('postgres')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

const app = express()
const PORT = process.env.PORT || 3001
const JWT_SECRET = process.env.JWT_SECRET || 'CAMBIAR_ESTE_SECRET'

// ------------------------
// Base de datos (postgres.js)
// ------------------------
const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : undefined,
  idle_timeout: 20,
  max_lifetime: 60 * 30
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
  if (!plate) return null
  return String(plate).toUpperCase().replace(/\s+/g, '')
}

// --- NUEVO: helpers para fechas / días hábiles ---

// feriados fijos (mes-día). Podés agregar más si querés.
const FIXED_HOLIDAYS_MMDD = new Set([
  '01-01', // Año Nuevo
  '03-24', // Memoria
  '04-02', // Malvinas
  '05-01', // Trabajo
  '05-25', // Revolución de Mayo
  '06-20', // Belgrano
  '07-09', // Independencia
  '08-17', // San Martín
  '10-12', // Diversidad cultural
  '11-20', // Soberanía
  '12-08', // Inmaculada
  '12-25'  // Navidad
])

function isWeekend(date) {
  const day = date.getDay() // 0 domingo, 6 sábado
  return day === 0 || day === 6
}

function isHoliday(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const key = `${mm}-${dd}`
  return FIXED_HOLIDAYS_MMDD.has(key)
}

function getNextBusinessDay(date) {
  const d = new Date(date)
  // avanzar hasta que no sea fin de semana ni feriado
  while (isWeekend(d) || isHoliday(d)) {
    d.setDate(d.getDate() + 1)
  }
  return d
}

function diffInDays(a, b) {
  // diferencia en días entre dos fechas, normalizado a medianoche
  const msPerDay = 24 * 60 * 60 * 1000
  const aUTC = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const bUTC = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((aUTC - bUTC) / msPerDay)
}

function parseDate(value) {
  if (!value) return null
  if (value instanceof Date) return value
  // Asumimos string "YYYY-MM-DD" o similar
  const s = String(value).slice(0, 10) // YYYY-MM-DD
  const [yStr, mStr, dStr] = s.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  if (!y || !m || !d) return null
  // Usamos UTC para evitar quilombos de timezone
  return new Date(Date.UTC(y, m - 1, d))
}

function addDays(baseDate, days) {
  const base = parseDate(baseDate)
  if (!base) return null
  const d = new Date(base.getTime())
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

// Recalcula lastService y nextReminder para un vehículo
async function computeVehicleCategory(plate) {
  if (!plate) return
  try {
    // Traemos TODOS los services de ese vehículo, ordenados del más nuevo al más viejo
    const services = await many(sql`
      SELECT "date"
      FROM "Service"
      WHERE "vehicleId" = ${plate}
      ORDER BY "date" DESC
    `)

    if (!services || services.length === 0) {
      // Sin services -> limpiamos lastService y nextReminder
      await one(sql`
        UPDATE "Vehicle"
        SET
          "lastService" = NULL,
          "nextReminder" = NULL,
          "updatedAt" = NOW()
        WHERE "plate" = ${plate}
        RETURNING "plate"
      `)
      return
    }

    // Deduplicamos por día (si hay services el mismo día, se consideran uno solo)
    const uniqueDates = []
    const seen = new Set()

    for (const row of services) {
      const d = parseDate(row.date)
      if (!d) continue
      const key = d.toISOString().slice(0, 10) // YYYY-MM-DD
      if (!seen.has(key)) {
        seen.add(key)
        uniqueDates.push(d)
      }
    }

    if (uniqueDates.length === 0) {
      await one(sql`
        UPDATE "Vehicle"
        SET
          "lastService" = NULL,
          "nextReminder" = NULL,
          "updatedAt" = NOW()
        WHERE "plate" = ${plate}
        RETURNING "plate"
      `)
      return
    }

    // El último service es el más reciente
    const lastService = uniqueDates[0]

    // Regla de días:
    // - Si hay solo un service: 180 días
    // - Si hay 2 o más: usamos SOLO los dos más recientes (uniqueDates[0] y uniqueDates[1])
    //   calculamos la diferencia y aplicamos:
    //   >180      -> 180
    //   180..120  -> 120
    //   120..90   -> 90
    //   90..60    -> 60
    //   <60       -> 45
    let daysToAdd = 180

    if (uniqueDates.length >= 2) {
      const d1 = uniqueDates[0] // más reciente
      const d2 = uniqueDates[1] // segundo más reciente
      const diff = Math.abs(diffInDays(d1, d2))

      if (diff > 180) {
        daysToAdd = 180
      } else if (diff > 120) {
        daysToAdd = 120
      } else if (diff > 90) {
        daysToAdd = 90
      } else if (diff > 60) {
        daysToAdd = 60
      } else {
        daysToAdd = 45
      }
    } else {
      // solo un service
      daysToAdd = 180
    }

    // Fecha tentativa = último service + daysToAdd
    let nextReminder = addDays(lastService, daysToAdd)

    // Ajustar a día hábil (no sábado, no domingo, no feriado)
    nextReminder = getNextBusinessDay(nextReminder)

    // Guardamos en Vehicle
    await one(sql`
      UPDATE "Vehicle"
      SET
        "lastService"  = ${lastService},
        "nextReminder" = ${nextReminder},
        "updatedAt"    = NOW()
      WHERE "plate" = ${plate}
      RETURNING "plate"
    `)
  } catch (err) {
    console.error('Error en computeVehicleCategory:', err.message)
  }
}

// ------------------------
// Middlewares
// ------------------------
app.use(cors())
app.use(bodyParser.json())

// Middleware simple de autenticación con JWT
function authMiddleware(req, _res, next) {
  const auth = req.headers.authorization || ''
  const [type, token] = auth.split(' ')
  if (!token || type !== 'Bearer') {
    return next()
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET)
    // payload: { userId, username, isAdmin }
    req.user = payload
    return next()
  } catch (_err) {
    return next()
  }
}

app.use(authMiddleware)

// ------------------------
// Health
// ------------------------
app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

// ------------------------
// LOGIN
// ------------------------
// Tabla users: id, username, password_hash, name, is_admin, created_at, updated_at
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ error: 'username y password son requeridos' })
    }

    const user = await one(sql`
      SELECT id, username, password_hash, name, is_admin
      FROM "users"
      WHERE username = ${username}
      LIMIT 1`)

    if (!user) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' })
    }

    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' })
    }

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        isAdmin: !!user.is_admin
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    )

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name || null,
        isAdmin: !!user.is_admin
      }
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al hacer login' })
  }
})

// ------------------------
// ADMIN: USUARIOS / EMPLEADOS
// ------------------------

// Lista de usuarios (empleados), accesible para cualquier usuario logueado
app.get('/api/users', async (req, res) => {
  try {
    // solo verificamos que esté logueado
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' })
    }

    const currentId = req.user.userId

    const rows = await many(sql`
      SELECT
        id,
        username,
        name,
        is_admin AS "isAdmin",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM "users"
      WHERE id <> ${currentId}
      ORDER BY username ASC
    `)

    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener usuarios' })
  }
})

// Crear usuario (solo admin)
app.post('/api/users', async (req, res) => {
  try {
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({ error: 'Solo el admin puede crear usuarios' })
    }

    const { name, username, password, isAdmin } = req.body

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: 'username y password son requeridos' })
    }

    if (String(password).length < 4) {
      return res
        .status(400)
        .json({ error: 'La contraseña debe tener al menos 4 caracteres' })
    }

    // ¿ya existe?
    theExisting = await one(sql`
      SELECT id FROM "users" WHERE username = ${username} LIMIT 1
    `)
    if (theExisting) {
      return res
        .status(400)
        .json({ error: 'Ya existe un usuario con ese username' })
    }

    const hash = await bcrypt.hash(String(password), 10)

    const newUser = await one(sql`
      INSERT INTO "users"
        ("username", "password_hash", "name", "is_admin", "created_at", "updated_at")
      VALUES (
        ${username},
        ${hash},
        ${name ?? null},
        ${!!isAdmin},
        NOW(),
        NOW()
      )
      RETURNING
        id,
        username,
        name,
        is_admin AS "isAdmin",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `)

    res.status(201).json(newUser)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al crear usuario' })
  }
})

// Cambiar password de un usuario (pide clave del admin)
app.post('/api/users/change-password', async (req, res) => {
  try {
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({ error: 'Solo el admin puede cambiar contraseñas' })
    }

    const { userId, adminPassword, newPassword } = req.body

    if (!userId || !adminPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: 'userId, adminPassword y newPassword son requeridos' })
    }

    if (String(newPassword).length < 4) {
      return res
        .status(400)
        .json({ error: 'La nueva contraseña debe tener al menos 4 caracteres' })
    }

    const admin = await one(sql`
      SELECT id, password_hash
      FROM "users"
      WHERE id = ${req.user.userId}
      LIMIT 1`)

    if (!admin) {
      return res.status(401).json({ error: 'Admin no encontrado' })
    }

    const ok = await bcrypt.compare(adminPassword, admin.password_hash)
    if (!ok) {
      return res.status(401).json({ error: 'Clave de admin incorrecta' })
    }

    const hash = await bcrypt.hash(String(newPassword), 10)

    const updated = await one(sql`
      UPDATE "users"
      SET password_hash = ${hash},
          updated_at    = NOW()
      WHERE id = ${userId}
      RETURNING id, username, name`)

    if (!updated) {
      return res.status(404).json({ error: 'Usuario no encontrado' })
    }

    res.json({
      ok: true,
      user: {
        id: updated.id,
        username: updated.username,
        name: updated.name
      }
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al cambiar contraseña' })
  }
})

// ------------------------
// CATEGORÍAS
// ------------------------
app.get('/api/categories', async (_req, res) => {
  try {
    const rows = await many(sql`
      SELECT id, name, "everyDays", "createdAt", "updatedAt"
      FROM "Category"
      ORDER BY "name" ASC`)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener categorías' })
  }
})

// --------------------------------------------------
// VEHÍCULOS
// --------------------------------------------------
app.get('/api/vehicles', async (_req, res) => {
  try {
    const rows = await many(sql`
      SELECT
        v."plate",
        v."brand",
        v."model",
        v."year",
        v."categoryId",
        v."lastService",
        v."nextReminder",
        v."contactName",
        v."contactPhone",
        v."createdAt",
        v."updatedAt",
        c.id   AS "categoryId2",
        c.name AS "categoryName",
        c."everyDays"
      FROM "Vehicle" v
      LEFT JOIN "Category" c ON c.id = v."categoryId"
      ORDER BY v."plate" ASC`)

    const shaped = rows.map(r => ({
      plate: r.plate,
      brand: r.brand,
      model: r.model,
      year: r.year,
      categoryId: r.categoryId,
      lastService: r.lastService,
      nextReminder: r.nextReminder,
      contactName: r.contactName,
      contactPhone: r.contactPhone,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      category: r.categoryId2
        ? { id: r.categoryId2, name: r.categoryName, everyDays: r.everyDays }
        : null
    }))

    res.json(shaped)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener vehículos' })
  }
})

// GET /api/vehicles/:plate – detalle + services (con empleado)
app.get('/api/vehicles/:plate', async (req, res) => {
  try {
    const plate = normalizePlate(req.params.plate)
    if (!plate) return res.status(400).json({ error: 'Patente inválida' })

    const v = await one(sql`
      SELECT
        v."plate",
        v."brand",
        v."model",
        v."year",
        v."categoryId",
        v."lastService",
        v."nextReminder",
        v."contactName",
        v."contactPhone",
        v."createdAt",
        v."updatedAt",
        c.id   AS "categoryId2",
        c.name AS "categoryName",
        c."everyDays"
      FROM "Vehicle" v
      LEFT JOIN "Category" c ON c.id = v."categoryId"
      WHERE v."plate" = ${plate}`)

    if (!v) return res.status(404).json({ error: 'Not found' })

    const services = await many(sql`
      SELECT
        s.id,
        s."vehicleId",
        s."userId",
        s."date",
        s."odometer",
        s."summary",
        s."oil",
        s."filterOil",
        s."filterAir",
        s."filterFuel",
        s."filterCabin",
        s."otherServices",
        s."totalPrice",
        s."createdAt",
        s."updatedAt",
        u."name"     AS "userName",
        u."username" AS "userUsername"
      FROM "Service" s
      LEFT JOIN "users" u ON u.id = s."userId"
      WHERE s."vehicleId" = ${plate}
      ORDER BY s."date" DESC
    `)

    const shapedServices = services.map(s => ({
      id: s.id,
      vehicleId: s.vehicleId,
      userId: s.userId,
      date: s.date,
      odometer: s.odometer,
      summary: s.summary,
      oil: s.oil,
      filterOil: s.filterOil,
      filterAir: s.filterAir,
      filterFuel: s.filterFuel,
      filterCabin: s.filterCabin,
      otherServices: s.otherServices,
      totalPrice: s.totalPrice,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      employee: s.userId
        ? {
            id: s.userId,
            name: s.userName,
            username: s.userUsername
          }
        : null
    }))

    res.json({
      plate: v.plate,
      brand: v.brand,
      model: v.model,
      year: v.year,
      categoryId: v.categoryId,
      lastService: v.lastService,
      nextReminder: v.nextReminder,
      contactName: v.contactName,
      contactPhone: v.contactPhone,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      category: v.categoryId2
        ? { id: v.categoryId2, name: v.categoryName, everyDays: v.everyDays }
        : null,
      services: shapedServices
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener vehículo' })
  }
})

// POST /api/vehicles
app.post('/api/vehicles', async (req, res) => {
  try {
    const plate = normalizePlate(req.body.plate)
    const { brand, model, year, categoryId, contactName, contactPhone } = req.body

    if (!plate) {
      return res.status(400).json({ error: 'Patente requerida' })
    }

    const v = await one(sql`
      INSERT INTO "Vehicle"
        ("plate", "brand", "model", "year", "categoryId",
         "contactName", "contactPhone",
         "createdAt", "updatedAt")
      VALUES (
        ${plate},
        ${brand ?? null},
        ${model ?? null},
        ${year ?? null},
        ${categoryId ?? null},
        ${contactName ?? null},
        ${contactPhone ?? null},
        NOW(),
        NOW()
      )
      RETURNING *`)

    await computeVehicleCategory(plate)

    res.status(201).json(v)
  } catch (err) {
    console.error(err)
    if (err && err.code === '23505') {
      return res.status(400).json({ error: 'Ya existe un vehículo con esa patente' })
    }
    res.status(500).json({ error: 'Error al crear vehículo' })
  }
})


// PUT /api/vehicles/:plate
app.put('/api/vehicles/:plate', async (req, res) => {
  try {
    const plate = normalizePlate(req.params.plate)
    if (!plate) return res.status(400).json({ error: 'Patente inválida' })

    const {
      brand,
      model,
      year,
      categoryId,
      contactName,
      contactPhone,
      nextReminder // <-- NUEVO
    } = req.body

    const vehicle = await one(sql`
      UPDATE "Vehicle"
      SET "brand"        = ${brand ?? null},
          "model"        = ${model ?? null},
          "year"         = ${year ?? null},
          "categoryId"   = ${categoryId ?? null},
          "contactName"  = ${contactName ?? null},
          "contactPhone" = ${contactPhone ?? null},
          "nextReminder" = ${nextReminder ?? null}, -- <-- NUEVO
          "updatedAt"    = NOW()
      WHERE "plate" = ${plate}
      RETURNING *`)

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehículo no encontrado' })
    }

    res.json(vehicle)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al actualizar vehículo' })
  }
})

// ------------------------
// SERVICES
// ------------------------

// GET /api/services
app.get('/api/services', async (req, res) => {
  try {
    const { from, to } = req.query

    let where = sql`TRUE`
    if (from) {
      where = sql`${where} AND s."date" >= ${from}`
    }
    if (to) {
      where = sql`${where} AND s."date" <= ${to}`
    }

    const rows = await many(sql`
      SELECT
        s.id,
        s."vehicleId",
        s."userId",
        s."date",
        s."odometer",
        s."summary",
        s."oil",
        s."filterOil",
        s."filterAir",
        s."filterFuel",
        s."filterCabin",
        s."otherServices",
        s."totalPrice",
        s."createdAt",
        s."updatedAt",
        v."brand"        AS "vehicleBrand",
        v."model"        AS "vehicleModel",
        v."contactName"  AS "contactName",
        v."contactPhone" AS "contactPhone",
        u."name"         AS "userName",
        u."username"     AS "userUsername"
      FROM "Service" s
      LEFT JOIN "Vehicle" v ON v."plate" = s."vehicleId"
      LEFT JOIN "users"  u ON u.id       = s."userId"
      WHERE ${where}
      ORDER BY s."date" DESC, s.id DESC
    `)

    const shaped = rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicleId,
      userId: r.userId,
      date: r.date,
      odometer: r.odometer,
      summary: r.summary,
      oil: r.oil,
      filterOil: r.filterOil,
      filterAir: r.filterAir,
      filterFuel: r.filterFuel,
      filterCabin: r.filterCabin,
      otherServices: r.otherServices,
      totalPrice: r.totalPrice,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      vehicle: {
        brand: r.vehicleBrand,
        model: r.vehicleModel
      },
      contact: {
        name: r.contactName,
        phone: r.contactPhone
      },
      employee: r.userId
        ? {
            id: r.userId,
            name: r.userName,
            username: r.userUsername
          }
        : null
    }))

    res.json(shaped)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener services' })
  }
})

app.post('/api/services', async (req, res) => {
  try {
    const {
      vehicleId,
      date,
      odometer,
      summary,
      oil,
      filterOil,
      filterAir,
      filterFuel,
      filterCabin,
      otherServices,
      totalPrice,
      userId // <-- puede venir del front (empleado seleccionado)
    } = req.body

    if (!vehicleId || !date) {
      return res.status(400).json({ error: 'vehicleId y date son obligatorios' })
    }

    // priorizamos el userId que viene en el body (seleccionado en el front)
    let finalUserId = null
    if (userId != null) {
      finalUserId = Number(userId)
      if (Number.isNaN(finalUserId)) {
        finalUserId = null
      }
    } else if (req.user && req.user.userId) {
      // fallback: el usuario logueado
      finalUserId = req.user.userId
    }

    const service = await one(sql`
      INSERT INTO "Service"
        ("vehicleId", "userId", "date", "odometer", "summary",
         "oil", "filterOil", "filterAir", "filterFuel", "filterCabin",
         "otherServices", "totalPrice",
         "createdAt", "updatedAt")
      VALUES (
        ${vehicleId},
        ${finalUserId},
        ${date},
        ${odometer ?? null},
        ${summary ?? null},
        ${oil ?? null},
        ${filterOil ?? null},
        ${filterAir ?? null},
        ${filterFuel ?? null},
        ${filterCabin ?? null},
        ${otherServices ?? null},
        ${totalPrice ?? null},
        NOW(),
        NOW()
      )
      RETURNING *`)

    // recalcular lastService/nextReminder del vehículo con la lógica nueva
    await computeVehicleCategory(vehicleId)

    res.status(201).json(service)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al crear service' })
  }
})

// --------------------------------------------------
// MESSAGE TEMPLATE
// --------------------------------------------------
app.get('/api/message-templates', async (_req, res) => {
  try {
    const rows = await many(sql`
      SELECT id, name, body, "createdAt", "updatedAt"
      FROM "MessageTemplate"
      ORDER BY id ASC`)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener plantillas de mensajes' })
  }
})

app.get('/api/message-templates/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'id inválido' })

    const tpl = await one(sql`
      SELECT id, name, body, "createdAt", "updatedAt"
      FROM "MessageTemplate"
      WHERE id = ${id}`)

    if (!tpl) return res.status(404).json({ error: 'No encontrada' })

    res.json(tpl)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener plantilla' })
  }
})

app.post('/api/message-templates', async (req, res) => {
  try {
    const { name, body } = req.body
    if (!name || !body) {
      return res.status(400).json({ error: 'name y body son requeridos' })
    }

    const tpl = await one(sql`
      INSERT INTO "MessageTemplate"
        ("name", "body", "createdAt", "updatedAt")
      VALUES (
        ${name},
        ${body},
        NOW(),
        NOW()
      )
      RETURNING id, name, body, "createdAt", "updatedAt"`)

    res.status(201).json(tpl)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al crear plantilla' })
  }
})

app.put('/api/message-templates/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'id inválido' })

    const { name, body } = req.body
    if (!name || !body) {
      return res.status(400).json({ error: 'name y body son requeridos' })
    }

    const tpl = await one(sql`
      UPDATE "MessageTemplate"
      SET "name" = ${name},
          "body" = ${body},
          "updatedAt" = NOW()
      WHERE id = ${id}
      RETURNING id, name, body, "createdAt", "updatedAt"`)

    if (!tpl) return res.status(404).json({ error: 'No encontrada' })

    res.json(tpl)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al actualizar plantilla' })
  }
})

app.delete('/api/message-templates/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'id inválido' })

    const tpl = await one(sql`
      DELETE FROM "MessageTemplate"
      WHERE id = ${id}
      RETURNING id`)

    if (!tpl) return res.status(404).json({ error: 'No encontrada' })

    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al eliminar plantilla' })
  }
})

// ------------------------
// Arranque del server
// ------------------------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
