require('dotenv').config()

const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const postgres = require('postgres')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const https = require('https')

const app = express()

const PORT = process.env.PORT || 3001
const JWT_SECRET = process.env.JWT_SECRET || 'CAMBIAR_ESTE_SECRET'

// ------------------------
// WhatsApp config
// ------------------------
const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED === 'true'
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN
// Nombre y lenguaje de la plantilla oficial de WhatsApp
// Ej: recordatorio_de_ubicacion · Spanish (ARG)
const WHATSAPP_TEMPLATE = process.env.WHATSAPP_TEMPLATE || 'recordatorio_de_ubicacion'
const WHATSAPP_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'es_AR'
const WHATSAPP_VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN || 'lubricentro_verify_token'

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

function normalizePhoneToWa(phone) {
  if (!phone) return null
  let cleaned = String(phone).replace(/\D/g, '')
  if (!cleaned) return null
  if (!cleaned.startsWith('54')) {
    cleaned = '54' + cleaned
  }
  return cleaned
}

// --- Helpers fechas / días hábiles ---

// feriados fijos (mes-día).
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
  while (isWeekend(d) || isHoliday(d)) {
    d.setDate(d.getDate() + 1)
  }
  return d
}

function diffInDays(a, b) {
  const msPerDay = 24 * 60 * 60 * 1000
  const aUTC = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const bUTC = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((aUTC - bUTC) / msPerDay)
}

// ✅ Versión "local" para evitar el -1 día por timezone
function parseDate(value) {
  if (!value) return null
  if (value instanceof Date) return value

  const s = String(value).slice(0, 10) // YYYY-MM-DD
  const [yStr, mStr, dStr] = s.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  if (!y || !m || !d) return null

  return new Date(y, m - 1, d)
}

function addDays(baseDate, days) {
  const base = parseDate(baseDate)
  if (!base) return null
  const d = new Date(base.getTime())
  d.setDate(d.getDate() + days)
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
      await one(sql`
        UPDATE "Vehicle"
        SET "lastService" = NULL,
            "nextReminder" = NULL,
            "updatedAt" = NOW()
        WHERE "plate" = ${plate}
        RETURNING "plate"
      `)
      return
    }

    // Deduplicamos por día
    const uniqueDates = []
    const seen = new Set()
    for (const row of services) {
      const d = parseDate(row.date)
      if (!d) continue
      const key = d.toISOString().slice(0, 10)
      if (!seen.has(key)) {
        seen.add(key)
        uniqueDates.push(d)
      }
    }

    if (uniqueDates.length === 0) {
      await one(sql`
        UPDATE "Vehicle"
        SET "lastService" = NULL,
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
    // - Si hay 2 o más: usamos solo los dos más recientes
    let daysToAdd = 180
    if (uniqueDates.length >= 2) {
      const d1 = uniqueDates[0]
      const d2 = uniqueDates[1]
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
      daysToAdd = 180
    }

    let nextReminder = addDays(lastService, daysToAdd)
    nextReminder = getNextBusinessDay(nextReminder)

    await one(sql`
      UPDATE "Vehicle"
      SET "lastService" = ${lastService},
          "nextReminder" = ${nextReminder},
          "updatedAt" = NOW()
      WHERE "plate" = ${plate}
      RETURNING "plate"
    `)
  } catch (err) {
    console.error('Error en computeVehicleCategory:', err.message)
  }
}

// ------------------------
// Helper para WhatsApp Cloud API (plantilla)
// ------------------------
function sendWhatsAppTemplate(to) {
  return new Promise((resolve, reject) => {
    if (!WHATSAPP_ENABLED) {
      console.log('[WHATSAPP] Deshabilitado. Simulando envío a:', to)
      return resolve({ simulated: true })
    }
    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
      return reject(new Error('WhatsApp API no configurada correctamente'))
    }

    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: WHATSAPP_TEMPLATE,
        language: {
          code: WHATSAPP_TEMPLATE_LANG
        }
        // Si tu plantilla usa variables, acá se agregan "components"
        // components: [...]
      }
    })

    const options = {
      hostname: 'graph.facebook.com',
      path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    }

    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = body ? JSON.parse(body) : null
            console.log('[WHATSAPP] OK ->', to, json)
            resolve(json)
          } catch (_e) {
            console.log('[WHATSAPP] OK (sin JSON parseable) ->', to, body)
            resolve({ raw: body })
          }
        } else {
          console.error('[WHATSAPP] ERROR', res.statusCode, body)
          reject(new Error(body || `WhatsApp status ${res.statusCode}`))
        }
      })
    })

    req.on('error', (err) => {
      console.error('[WHATSAPP] request error:', err)
      reject(err)
    })

    req.write(payload)
    req.end()
  })
}

// ------------------------
// Helper para WhatsApp Cloud API (texto directo)
// ------------------------
function sendWhatsAppTextMessage(to, body) {
  return new Promise((resolve, reject) => {
    if (!WHATSAPP_ENABLED) {
      console.log('[WHATSAPP TEXT] Deshabilitado. Simulando envío de texto a:', to)
      return resolve({ simulated: true })
    }

    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
      return reject(new Error('WhatsApp API no configurada correctamente'))
    }

    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body
      }
    })

    const options = {
      hostname: 'graph.facebook.com',
      path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    }

    const req = https.request(options, (res) => {
      let bodyResp = ''
      res.on('data', (chunk) => {
        bodyResp += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = bodyResp ? JSON.parse(bodyResp) : null
            console.log('[WHATSAPP TEXT] OK ->', to, json)
            resolve(json)
          } catch (_e) {
            console.log('[WHATSAPP TEXT] OK (sin JSON parseable) ->', to, bodyResp)
            resolve({ raw: bodyResp })
          }
        } else {
          console.error('[WHATSAPP TEXT] ERROR', res.statusCode, bodyResp)
          reject(new Error(bodyResp || `WhatsApp status ${res.statusCode}`))
        }
      })
    })

    req.on('error', (err) => {
      console.error('[WHATSAPP TEXT] request error:', err)
      reject(err)
    })

    req.write(payload)
    req.end()
  })
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
    const payload = jwt.verify(token, JWT_SECRET) // { userId, username, isAdmin }
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
      LIMIT 1
    `)

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
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' })
    }
    const currentId = req.user.userId
    const rows = await many(sql`
      SELECT id,
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
      return res.status(400).json({ error: 'username y password son requeridos' })
    }
    if (String(password).length < 4) {
      return res
        .status(400)
        .json({ error: 'La contraseña debe tener al menos 4 caracteres' })
    }

    const existing = await one(sql`
      SELECT id
      FROM "users"
      WHERE username = ${username}
      LIMIT 1
    `)
    if (existing) {
      return res
        .status(400)
        .json({ error: 'Ya existe un usuario con ese username' })
    }

    const hash = await bcrypt.hash(String(password), 10)
    const newUser = await one(sql`
      INSERT INTO "users" ("username", "password_hash", "name", "is_admin", "created_at", "updated_at")
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
      LIMIT 1
    `)

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
          updated_at = NOW()
      WHERE id = ${userId}
      RETURNING id, username, name
    `)

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
      ORDER BY "name" ASC
    `)
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
        c.id AS "categoryId2",
        c.name AS "categoryName",
        c."everyDays"
      FROM "Vehicle" v
      LEFT JOIN "Category" c ON c.id = v."categoryId"
      ORDER BY v."plate" ASC
    `)

    const shaped = rows.map((r) => ({
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
        ? {
            id: r.categoryId2,
            name: r.categoryName,
            everyDays: r.everyDays
          }
        : null
    }))

    res.json(shaped)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener vehículos' })
  }
})

// GET /api/vehicles/:plate – detalle + services
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
        c.id AS "categoryId2",
        c.name AS "categoryName",
        c."everyDays"
      FROM "Vehicle" v
      LEFT JOIN "Category" c ON c.id = v."categoryId"
      WHERE v."plate" = ${plate}
    `)

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
        u."name" AS "userName",
        u."username" AS "userUsername"
      FROM "Service" s
      LEFT JOIN "users" u ON u.id = s."userId"
      WHERE s."vehicleId" = ${plate}
      ORDER BY s."date" DESC
    `)

    const shapedServices = services.map((s) => ({
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
        ? {
            id: v.categoryId2,
            name: v.categoryName,
            everyDays: v.everyDays
          }
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
      INSERT INTO "Vehicle" (
        "plate", "brand", "model", "year",
        "categoryId", "contactName", "contactPhone",
        "createdAt", "updatedAt"
      )
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
      RETURNING *
    `)

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
      nextReminder
    } = req.body

    const vehicle = await one(sql`
      UPDATE "Vehicle"
      SET "brand"        = ${brand ?? null},
          "model"        = ${model ?? null},
          "year"         = ${year ?? null},
          "categoryId"   = ${categoryId ?? null},
          "contactName"  = ${contactName ?? null},
          "contactPhone" = ${contactPhone ?? null},
          "nextReminder" = ${nextReminder ?? null},
          "updatedAt"    = NOW()
      WHERE "plate" = ${plate}
      RETURNING *
    `)

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
        v."brand" AS "vehicleBrand",
        v."model" AS "vehicleModel",
        v."contactName" AS "contactName",
        v."contactPhone" AS "contactPhone",
        u."name" AS "userName",
        u."username" AS "userUsername"
      FROM "Service" s
      LEFT JOIN "Vehicle" v ON v."plate" = s."vehicleId"
      LEFT JOIN "users" u   ON u.id      = s."userId"
      WHERE ${where}
      ORDER BY s."date" DESC, s.id DESC
    `)

    const shaped = rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicleId,
      userId: r.userId,
      date: r.date,
      odometer: r.odometer,
      summary: null, // no usamos el summary viejo en listado
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

// POST /api/services
app.post('/api/services', async (req, res) => {
  try {
    const {
      vehicleId,
      date,
      odometer,
      // summary,
      oil,
      filterOil,
      filterAir,
      filterFuel,
      filterCabin,
      otherServices,
      totalPrice,
      userId
    } = req.body

    if (!vehicleId || !date) {
      return res.status(400).json({ error: 'vehicleId y date son obligatorios' })
    }

    // priorizamos el userId que viene en el body
    let finalUserId = null
    if (userId != null) {
      finalUserId = Number(userId)
      if (Number.isNaN(finalUserId)) {
        finalUserId = null
      }
    } else if (req.user && req.user.userId) {
      finalUserId = req.user.userId
    }

    const service = await one(sql`
      INSERT INTO "Service" (
        "vehicleId",
        "userId",
        "date",
        "odometer",
        "summary",
        "oil",
        "filterOil",
        "filterAir",
        "filterFuel",
        "filterCabin",
        "otherServices",
        "totalPrice",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${vehicleId},
        ${finalUserId},
        ${date},
        ${odometer ?? null},
        ${null}, -- siempre guardamos summary NULL
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
      RETURNING *
    `)

    await computeVehicleCategory(vehicleId)
    res.status(201).json(service)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al crear service' })
  }
})

// --------------------------------------------------
// MESSAGE TEMPLATE (internas del sistema, no WA oficial)
// --------------------------------------------------
app.get('/api/message-templates', async (_req, res) => {
  try {
    const rows = await many(sql`
      SELECT id, name, body, "createdAt", "updatedAt"
      FROM "MessageTemplate"
      ORDER BY id ASC
    `)
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
      WHERE id = ${id}
    `)

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
      INSERT INTO "MessageTemplate" ("name", "body", "createdAt", "updatedAt")
      VALUES (
        ${name},
        ${body},
        NOW(),
        NOW()
      )
      RETURNING id, name, body, "createdAt", "updatedAt"
    `)

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
      RETURNING id, name, body, "createdAt", "updatedAt"
    `)

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
      RETURNING id
    `)

    if (!tpl) return res.status(404).json({ error: 'No encontrada' })
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al eliminar plantilla' })
  }
})

// --------------------------------------------------
// WHATSAPP: BROADCAST CON PLANTILLA OFICIAL
// --------------------------------------------------
/**
 * POST /api/whatsapp/broadcast
 * body: { plates: ["ABC123", "AA000AA", ...] }
 *
 * Usa la plantilla oficial de WhatsApp (recordatorio_de_ubicacion, es_AR)
 * y la envía a los clientes cuyos vehículos tengan teléfono.
 */
app.post('/api/whatsapp/broadcast', async (req, res) => {
  try {
    const { plates } = req.body

    if (!Array.isArray(plates) || plates.length === 0) {
      return res.status(400).json({
        error: 'plates es requerido y debe ser un array con al menos una patente'
      })
    }

    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
      return res
        .status(500)
        .json({ error: 'WhatsApp Cloud API no está configurado en el servidor' })
    }

    // Normalizamos patentes
    const normalizedPlates = plates
      .map((p) => normalizePlate(p))
      .filter(Boolean)

    if (normalizedPlates.length === 0) {
      return res.status(400).json({ error: 'No hay patentes válidas' })
    }

    const vehicles = await many(sql`
      SELECT "plate", "contactPhone"
      FROM "Vehicle"
      WHERE "plate" = ANY(${sql.array(normalizedPlates, 'text')})
    `)

    const successes = []
    const errors = []

    for (const v of vehicles) {
      const waPhone = normalizePhoneToWa(v.contactPhone)
      if (!waPhone) {
        console.warn('[WHATSAPP] Vehículo sin teléfono válido:', v.plate)
        errors.push({
          plate: v.plate,
          reason: 'Teléfono inválido o faltante'
        })
        continue
      }

      try {
        await sendWhatsAppTemplate(waPhone)
        successes.push({ plate: v.plate, phone: waPhone })
      } catch (err) {
        console.error('[WHATSAPP] Error enviando a', v.plate, err.message)
        errors.push({
          plate: v.plate,
          phone: waPhone,
          reason: err.message
        })
      }
    }

    res.json({
      ok: true,
      template: WHATSAPP_TEMPLATE,
      language: WHATSAPP_TEMPLATE_LANG,
      sent: successes.length,
      failed: errors.length,
      successes,
      errors
    })
  } catch (err) {
    console.error('[WHATSAPP] broadcast error:', err)
    res.status(500).json({ error: 'Error interno enviando mensajes de WhatsApp' })
  }
})

// --------------------------------------------------
// WHATSAPP WEBHOOK (ENTRANTE)
// --------------------------------------------------
/**
 * GET /webhook/whatsapp
 * verificación que hace Meta al configurar el webhook.
 */
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('[WHATSAPP] Webhook verificado correctamente')
    return res.status(200).send(challenge)
  }

  console.warn('[WHATSAPP] Verificación de webhook fallida')
  return res.sendStatus(403)
})

/**
 * POST /webhook/whatsapp
 * Meta manda acá todos los eventos (mensajes entrantes, etc.).
 * Por ahora solo lo logueamos.
 */
app.post('/webhook/whatsapp', (req, res) => {
  try {
    console.log(
      '📩 [WHATSAPP] Webhook payload:\n',
      JSON.stringify(req.body, null, 2)
    )
  } catch (e) {
    console.error('[WHATSAPP] Error logueando body:', e)
  }

  // Podrías guardar en DB si querés, acá solo confirmamos 200
  res.sendStatus(200)
})

// ------------------------
// WhatsApp: envío de texto (single o bulk)
// ------------------------
app.post('/api/whatsapp/send-bulk-text', async (req, res) => {
  try {
    if (!WHATSAPP_ENABLED) {
      return res.status(400).json({ error: 'WhatsApp está deshabilitado en el servidor' })
    }

    const { to, body, messages } = req.body || {}

    // Normalizamos distintas formas de llamar al endpoint:
    // 1) { to: "549..." , body: "texto" }
    // 2) { to: ["549...", "549..."], body: "texto" }
    // 3) { messages: [ { to: "...", body: "..." }, ... ] }
    const items = []

    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (m && m.to && m.body) {
          items.push({ to: m.to, body: m.body })
        }
      }
    } else if (Array.isArray(to)) {
      for (const phone of to) {
        if (phone) {
          items.push({ to: phone, body })
        }
      }
    } else if (to && body) {
      items.push({ to, body })
    }

    if (!items.length) {
      return res.status(400).json({
        error:
          'Formato inválido. Esperado: { to, body } o { to:[...], body } o { messages:[{to,body},...] }'
      })
    }

    const results = []
    for (const item of items) {
      try {
        const r = await sendWhatsAppTextMessage(item.to, item.body)
        results.push({ to: item.to, ok: true, response: r || null })
      } catch (err) {
        console.error('[WHATSAPP] Falló envío a', item.to, err)
        results.push({ to: item.to, ok: false, error: err.message })
      }
    }

    return res.json({ ok: true, count: results.length, results })
  } catch (err) {
    console.error('Error en /api/whatsapp/send-bulk-text:', err)
    res.status(500).json({ error: 'Error interno enviando WhatsApp' })
  }
})

// ------------------------
// Arranque del server
// ------------------------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
