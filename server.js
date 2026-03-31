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
const WHATSAPP_BROADCAST_TEST_PHONES = [
  '3572400170',
  '3512011806'
]
const WHATSAPP_BROADCAST_BLOCKED =
  process.env.WHATSAPP_BROADCAST_BLOCKED === 'true'
const WHATSAPP_BROADCAST_BLOCK_DELAY_MS = Number(
  process.env.WHATSAPP_BROADCAST_BLOCK_DELAY_MS || 10000
)
const WHATSAPP_BROADCAST_BLOCK_MESSAGE =
  process.env.WHATSAPP_BROADCAST_BLOCK_MESSAGE ||
  'el servicio de Meta/api whatsapp no ejecutó la función, motivo: "a payment method must be assigned"'

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

const BROADCAST_LOOKBACK_DAYS = 30
let broadcastHistorySchemaReady = false

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureBroadcastHistorySchema() {
  if (broadcastHistorySchemaReady) return

  await sql`
    CREATE TABLE IF NOT EXISTS "BroadcastHistory" (
      "id" BIGSERIAL PRIMARY KEY,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "createdByUserId" INTEGER NULL,
      "template" TEXT NULL,
      "language" TEXT NULL,
      "requestedPlateCount" INTEGER NOT NULL DEFAULT 0,
      "processedVehicleCount" INTEGER NOT NULL DEFAULT 0,
      "sentCount" INTEGER NOT NULL DEFAULT 0,
      "failedCount" INTEGER NOT NULL DEFAULT 0,
      "skippedRecentCount" INTEGER NOT NULL DEFAULT 0,
      "invalidPhoneCount" INTEGER NOT NULL DEFAULT 0,
      "testSent" INTEGER NOT NULL DEFAULT 0,
      "testFailed" INTEGER NOT NULL DEFAULT 0,
      "batchPlates" TEXT NULL,
      "batchTestPhones" TEXT NULL
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS "BroadcastHistoryRecipient" (
      "id" BIGSERIAL PRIMARY KEY,
      "historyId" BIGINT NOT NULL REFERENCES "BroadcastHistory"("id") ON DELETE CASCADE,
      "plate" TEXT NULL,
      "phone" TEXT NULL,
      "status" TEXT NOT NULL,
      "reason" TEXT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "sentAt" TIMESTAMPTZ NULL
    )
  `

  await sql`
    CREATE INDEX IF NOT EXISTS "BroadcastHistory_createdAt_idx"
    ON "BroadcastHistory" ("createdAt" DESC)
  `

  await sql`
    CREATE INDEX IF NOT EXISTS "BroadcastHistoryRecipient_historyId_idx"
    ON "BroadcastHistoryRecipient" ("historyId")
  `

  await sql`
    CREATE INDEX IF NOT EXISTS "BroadcastHistoryRecipient_phone_sentAt_idx"
    ON "BroadcastHistoryRecipient" ("phone", "sentAt" DESC)
  `

  broadcastHistorySchemaReady = true
}

async function insertBroadcastHistoryRecipient({ historyId, plate = null, phone = null, status, reason = null, sentAt = null }) {
  await sql`
    INSERT INTO "BroadcastHistoryRecipient" (
      "historyId",
      "plate",
      "phone",
      "status",
      "reason",
      "createdAt",
      "sentAt"
    )
    VALUES (
      ${historyId},
      ${plate},
      ${phone},
      ${status},
      ${reason},
      NOW(),
      ${sentAt}
    )
  `
}

async function findRecentSuccessfulBroadcastByPhone(phone) {
  if (!phone) return null

  return one(sql`
    SELECT "sentAt"
    FROM "BroadcastHistoryRecipient"
    WHERE "phone" = ${phone}
      AND "status" = 'sent'
      AND "sentAt" IS NOT NULL
      AND "sentAt" >= NOW() - (${BROADCAST_LOOKBACK_DAYS} * INTERVAL '1 day')
    ORDER BY "sentAt" DESC
    LIMIT 1
  `)
}

// ------------------------
// Helpers
// ------------------------
function normalizePlate(plate) {
  if (!plate) return null
  return String(plate).toUpperCase().replace(/\s+/g, '')
}

/**
 * Normaliza teléfonos a formato de WhatsApp solo dígitos: 549 + código de área + número.
 * Ejemplos de entrada válidos:
 *  - "0351 15 791-6505"
 *  - "+54 9 351 7916505"
 *  - "3517916505"
 *  - "5493517916505"
 *
 * Salida siempre: "5493517916505"
 */
function normalizePhoneToWa(phone) {
  if (!phone) return null
  let cleaned = String(phone).replace(/\D/g, '')
  if (!cleaned) return null

  // Si ya viene bien como 549..., lo dejamos
  if (cleaned.startsWith('549')) {
    return cleaned
  }

  // Si viene con prefijo internacional 00 (ej: 0054...)
  if (cleaned.startsWith('00')) {
    cleaned = cleaned.slice(2) // quita "00" → queda 54...
  }

  // Si arranca con 54, lo sacamos para después anteponer 549
  if (cleaned.startsWith('54')) {
    cleaned = cleaned.slice(2)
  }

  // Si arranca con 0 (código de área con 0), lo sacamos
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.slice(1)
  }

  // Si arranca con 15 (celu viejo con 15), lo sacamos
  if (cleaned.startsWith('15')) {
    cleaned = cleaned.slice(2)
  }

  // Resultado final: solo dígitos, formato 549 + código de área + número
  return '549' + cleaned
}

function normalizePhoneListToWa(phones) {
  if (!Array.isArray(phones)) return []

  return Array.from(
    new Set(
      phones
        .map((phone) => normalizePhoneToWa(phone))
        .filter(Boolean)
    )
  )
}

function formatDateForWhatsAppTemplate(value) {
  if (!value) return 'sin fecha'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'sin fecha'
  return date.toLocaleDateString('es-AR')
}

function sanitizeContactName(name) {
  const raw = String(name || '').trim()
  if (!raw) return 'estimado cliente'

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')

  const invalidNames = new Set(['no', 'nose', 'ns', 'na', 'sinnombre'])
  return invalidNames.has(normalized) ? 'estimado cliente' : raw
}

function buildTemplateTextParameter(value, fallback) {
  const trimmed = String(value ?? '').trim()
  if (trimmed) return trimmed
  return fallback
}

const WHATSAPP_BROADCAST_TEMPLATES = {
  recordatorio_de_ubicacion: {
    name: 'recordatorio_de_ubicacion',
    label: 'Recordatorio de ubicación / acceso',
    buildParameters: () => []
  },
  recordatorio_service: {
    name: 'recordatorio_service',
    label: 'Recordatorio service',
    buildParameters: (vehicle = {}) => [
      buildTemplateTextParameter(vehicle.brand, 'tu vehículo'),
      buildTemplateTextParameter(vehicle.model, 'sin modelo'),
      buildTemplateTextParameter(vehicle.plate, 'sin patente'),
      formatDateForWhatsAppTemplate(vehicle.lastService)
    ]
  },
  agradecer_visita: {
    name: 'agradecer_visita',
    label: 'Gracias por tu visita',
    buildParameters: (vehicle = {}) => [
      sanitizeContactName(vehicle.contactName),
      buildTemplateTextParameter(vehicle.brand, 'tu vehículo'),
      buildTemplateTextParameter(vehicle.model, 'sin modelo'),
      buildTemplateTextParameter(vehicle.plate, 'sin patente')
    ]
  },
  promo_marzo: {
    name: 'promo_marzo',
    label: 'Promo especial lubricentro',
    buildParameters: () => []
  }
}

function getBroadcastTemplateConfig(templateName) {
  const normalizedName = String(templateName || '').trim()
  return (
    WHATSAPP_BROADCAST_TEMPLATES[normalizedName] ||
    WHATSAPP_BROADCAST_TEMPLATES[WHATSAPP_TEMPLATE] ||
    WHATSAPP_BROADCAST_TEMPLATES.recordatorio_de_ubicacion
  )
}

function buildWhatsAppTemplateComponents(templateConfig, vehicle) {
  const parameters = templateConfig.buildParameters(vehicle)
  if (!parameters.length) return undefined

  return [
    {
      type: 'body',
      parameters: parameters.map((value) => ({
        type: 'text',
        text: String(value)
      }))
    }
  ]
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
function sendWhatsAppTemplate(to, templateName, vehicle = null) {
  return new Promise((resolve, reject) => {
    const templateConfig = getBroadcastTemplateConfig(templateName)
    const components = buildWhatsAppTemplateComponents(templateConfig, vehicle)

    if (!WHATSAPP_ENABLED) {
      console.log(
        '[WHATSAPP] Deshabilitado. Simulando envío a:',
        to,
        'template:',
        templateConfig.name,
        'components:',
        components
      )
      return resolve({ simulated: true, template: templateConfig.name, components })
    }
    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
      return reject(new Error('WhatsApp API no configurada correctamente'))
    }

    const templatePayload = {
      name: templateConfig.name,
      language: {
        code: WHATSAPP_TEMPLATE_LANG
      }
    }

    if (components) {
      templatePayload.components = components
    }

    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: templatePayload
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
// Helper para WhatsApp Cloud API (texto libre)
// ------------------------
function sendWhatsAppTextMessage(to, body) {
  return new Promise((resolve, reject) => {
    if (!WHATSAPP_ENABLED) {
      console.log('[WHATSAPP TEXT] Deshabilitado. Simulando envío a:', to, '->', body)
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
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = data ? JSON.parse(data) : null
            console.log('[WHATSAPP TEXT] OK ->', to, json)
            resolve({ data: json })
          } catch (_e) {
            console.log('[WHATSAPP TEXT] OK (raw)->', to, data)
            resolve({ data: data })
          }
        } else {
          console.error('[WHATSAPP TEXT] ERROR', res.statusCode, data)
          reject(new Error(data || `WhatsApp TEXT status ${res.statusCode}`))
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


app.patch('/api/vehicles/:plate/plate', async (req, res) => {
  try {
    const oldPlate = normalizePlate(req.params.plate)
    const newPlate = normalizePlate(req.body?.newPlate || req.body?.plate)

    if (!oldPlate) return res.status(400).json({ error: 'Patente inválida' })
    if (!newPlate) return res.status(400).json({ error: 'Nueva patente requerida' })

    if (oldPlate === newPlate) {
      const existing = await one(sql`SELECT * FROM "Vehicle" WHERE "plate" = ${oldPlate}`)
      if (!existing) return res.status(404).json({ error: 'Vehículo no encontrado' })
      return res.json(existing)
    }

    let updatedVehicle = null

    await sql.begin(async (tx) => {
      const vRows = await tx`SELECT * FROM "Vehicle" WHERE "plate" = ${oldPlate}`
      const v = vRows[0] || null
      if (!v) {
        // Abort transaction by throwing
        const err = new Error('NOT_FOUND')
        err.httpStatus = 404
        throw err
      }

      const conflictRows = await tx`SELECT "plate" FROM "Vehicle" WHERE "plate" = ${newPlate}`
      if (conflictRows.length > 0) {
        const err = new Error('CONFLICT')
        err.httpStatus = 400
        throw err
      }

      const upRows = await tx`
        UPDATE "Vehicle"
        SET "plate" = ${newPlate},
            "updatedAt" = NOW()
        WHERE "plate" = ${oldPlate}
        RETURNING *
      `
      updatedVehicle = upRows[0] || null

      // Propagamos el cambio a los services ya cargados con la patente vieja
      await tx`
        UPDATE "Service"
        SET "vehicleId" = ${newPlate},
            "updatedAt" = NOW()
        WHERE "vehicleId" = ${oldPlate}
      `
    })

    await computeVehicleCategory(newPlate)
    return res.json(updatedVehicle)
  } catch (err) {
    if (err && err.httpStatus === 404) {
      return res.status(404).json({ error: 'Vehículo no encontrado' })
    }
    if (err && err.httpStatus === 400 && err.message === 'CONFLICT') {
      return res.status(400).json({ error: 'Ya existe un vehículo con esa patente' })
    }
    console.error(err)
    if (err && err.code === '23505') {
      return res.status(400).json({ error: 'Ya existe un vehículo con esa patente' })
    }
    return res.status(500).json({ error: 'Error al actualizar la patente' })
  }
})

// ------------------------
// SERVICES
// ------------------------
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
      summary: null,
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
        ${null},
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

app.get('/api/whatsapp/broadcast-history', async (req, res) => {
  try {
    await ensureBroadcastHistorySchema()

    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' })
    }

    const rows = await many(sql`
      SELECT
        h."id",
        h."createdAt",
        h."template",
        h."language",
        h."requestedPlateCount",
        h."processedVehicleCount",
        h."sentCount",
        h."failedCount",
        h."skippedRecentCount",
        h."invalidPhoneCount",
        h."testSent",
        h."testFailed",
        h."createdByUserId",
        u.username AS "createdByUsername",
        u.name AS "createdByName"
      FROM "BroadcastHistory" h
      LEFT JOIN "users" u ON u.id = h."createdByUserId"
      ORDER BY h."createdAt" DESC
      LIMIT 100
    `)

    return res.json(rows)
  } catch (err) {
    console.error('Error obteniendo historial de WhatsApp masivo:', err)
    return res.status(500).json({ error: 'Error al obtener el historial de WhatsApp masivo' })
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
 * body: {
 *   plates: ["ABC123", "AA000AA", ...],
 *   testPhones: ["3572400170", "3512011806"], // opcional, se envían primero
 *   templateName: "recordatorio_de_ubicacion" // opcional
 * }
 */
app.post('/api/whatsapp/broadcast', async (req, res) => {
  try {
    if (WHATSAPP_BROADCAST_BLOCKED) {
      await wait(WHATSAPP_BROADCAST_BLOCK_DELAY_MS)
      return res.status(503).json({
        error: WHATSAPP_BROADCAST_BLOCK_MESSAGE
      })
    }

    await ensureBroadcastHistorySchema()
    const { plates, testPhones, templateName } = req.body || {}
    const selectedTemplate = getBroadcastTemplateConfig(templateName)

    if (!Array.isArray(plates) || plates.length === 0) {
      return res.status(400).json({
        error: 'plates es requerido y debe ser un array con al menos una patente'
      })
    }

    // Normalizamos y deduplicamos patentes
    const normalizedPlates = Array.from(
      new Set(
        plates
          .map((p) => normalizePlate(p))
          .filter(Boolean)
      )
    )

    if (normalizedPlates.length === 0) {
      return res.status(400).json({ error: 'No hay patentes válidas' })
    }

    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
      return res
        .status(500)
        .json({ error: 'WhatsApp Cloud API no está configurado en el servidor' })
    }

    const normalizedTestPhones = normalizePhoneListToWa(
      Object.prototype.hasOwnProperty.call(req.body || {}, 'testPhones')
        ? testPhones
        : WHATSAPP_BROADCAST_TEST_PHONES
    )

    // Evitamos ANY(...) y arrays de Postgres para no disparar el 22P02.
    // Hacemos consultas simples por cada patente y armamos un map.
    const vehiclesMap = new Map()

    for (const plate of normalizedPlates) {
      const rows = await many(sql`
        SELECT "plate", "contactPhone", "contactName", "brand", "model", "lastService"
        FROM "Vehicle"
        WHERE "plate" = ${plate}
      `)
      for (const row of rows) {
        vehiclesMap.set(row.plate, row)
      }
    }

    const vehicles = Array.from(vehiclesMap.values())
    const sampleVehicle = vehicles[0] || { plate: normalizedPlates[0] || null }

    const history = await one(sql`
      INSERT INTO "BroadcastHistory" (
        "createdAt",
        "createdByUserId",
        "template",
        "language",
        "requestedPlateCount",
        "batchPlates",
        "batchTestPhones"
      )
      VALUES (
        NOW(),
        ${req.user?.userId ?? null},
        ${selectedTemplate.name},
        ${WHATSAPP_TEMPLATE_LANG},
        ${normalizedPlates.length},
        ${JSON.stringify(normalizedPlates)},
        ${JSON.stringify(normalizedTestPhones)}
      )
      RETURNING "id"
    `)

    const historyId = history?.id
    const testResults = []
    const successes = []
    const errors = []
    const skippedRecent = []
    let invalidPhoneCount = 0

    for (const phone of normalizedTestPhones) {
      try {
        await sendWhatsAppTemplate(phone, selectedTemplate.name, sampleVehicle)
        testResults.push({ phone, ok: true })
        await insertBroadcastHistoryRecipient({
          historyId,
          phone,
          status: 'test_sent',
          sentAt: new Date()
        })
      } catch (err) {
        console.error('[WHATSAPP] Error enviando test a', phone, err.message)
        testResults.push({
          phone,
          ok: false,
          reason: err.message
        })
        await insertBroadcastHistoryRecipient({
          historyId,
          phone,
          status: 'test_error',
          reason: err.message
        })
      }
    }

    for (const v of vehicles) {
      const waPhone = normalizePhoneToWa(v.contactPhone)
      if (!waPhone) {
        console.warn('[WHATSAPP] Vehículo sin teléfono válido:', v.plate)
        invalidPhoneCount += 1
        errors.push({
          plate: v.plate,
          reason: 'Teléfono inválido o faltante'
        })
        await insertBroadcastHistoryRecipient({
          historyId,
          plate: v.plate,
          status: 'invalid_phone',
          reason: 'Teléfono inválido o faltante'
        })
        continue
      }

      const recentSend = await findRecentSuccessfulBroadcastByPhone(waPhone)
      if (recentSend) {
        const lastSentAt = recentSend.sentAt
        const reason = `Ya se envió un mensaje a este número dentro de los últimos ${BROADCAST_LOOKBACK_DAYS} días`
        skippedRecent.push({
          plate: v.plate,
          phone: waPhone,
          reason,
          lastSentAt
        })
        await insertBroadcastHistoryRecipient({
          historyId,
          plate: v.plate,
          phone: waPhone,
          status: 'skipped_recent',
          reason
        })
        continue
      }

      try {
        await sendWhatsAppTemplate(waPhone, selectedTemplate.name, v)
        successes.push({ plate: v.plate, phone: waPhone })
        await insertBroadcastHistoryRecipient({
          historyId,
          plate: v.plate,
          phone: waPhone,
          status: 'sent',
          sentAt: new Date()
        })
      } catch (err) {
        console.error('[WHATSAPP] Error enviando a', v.plate, err.message)
        errors.push({
          plate: v.plate,
          phone: waPhone,
          reason: err.message
        })
        await insertBroadcastHistoryRecipient({
          historyId,
          plate: v.plate,
          phone: waPhone,
          status: 'error',
          reason: err.message
        })
      }
    }

    const testSent = testResults.filter((item) => item.ok).length
    const testFailed = testResults.length - testSent
    const failedCount = errors.length + skippedRecent.length

    await one(sql`
      UPDATE "BroadcastHistory"
      SET
        "processedVehicleCount" = ${vehicles.length},
        "sentCount" = ${successes.length},
        "failedCount" = ${failedCount},
        "skippedRecentCount" = ${skippedRecent.length},
        "invalidPhoneCount" = ${invalidPhoneCount},
        "testSent" = ${testSent},
        "testFailed" = ${testFailed}
      WHERE "id" = ${historyId}
      RETURNING "id"
    `)

    res.json({
      ok: true,
      historyId,
      template: selectedTemplate.name,
      language: WHATSAPP_TEMPLATE_LANG,
      sent: successes.length,
      failed: failedCount,
      skippedRecentCount: skippedRecent.length,
      invalidPhoneCount,
      testSent,
      testFailed,
      testResults,
      successes,
      skippedRecent,
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

app.post('/webhook/whatsapp', (req, res) => {
  try {
    console.log(
      '📩 [WHATSAPP] Webhook payload:\n',
      JSON.stringify(req.body, null, 2)
    )
  } catch (e) {
    console.error('[WHATSAPP] Error logueando body:', e)
  }
  res.sendStatus(200)
})

// ------------------------
// WhatsApp: envío de texto (single o bulk)
// ------------------------
app.post('/api/whatsapp/send-bulk-text', async (req, res) => {
  try {
    if (WHATSAPP_BROADCAST_BLOCKED) {
      await wait(WHATSAPP_BROADCAST_BLOCK_DELAY_MS)
      return res.status(503).json({
        error: WHATSAPP_BROADCAST_BLOCK_MESSAGE
      })
    }

    if (!WHATSAPP_ENABLED) {
      return res.status(400).json({ error: 'WhatsApp está deshabilitado en el servidor' })
    }

    const { to, body, messages } = req.body || {}

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
        results.push({ to: item.to, ok: true, response: r.data || null })
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

  ensureBroadcastHistorySchema()
    .then(() => {
      console.log('[WHATSAPP] Historial de envíos masivos listo')
    })
    .catch((err) => {
      console.error('[WHATSAPP] No se pudo preparar el historial de envíos masivos:', err.message)
    })
})
