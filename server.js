// server.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { parse as parseCsv } from 'csv-parse/sync'
import { neon, neonConfig } from '@neondatabase/serverless'

neonConfig.fetchConnectionCache = true
const sql = neon(process.env.DATABASE_URL)

const app = express()
const upload = multer({ storage: multer.memoryStorage() })

/* ---------------- CORS ---------------- */
const allowed = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true)
    if (process.env.NODE_ENV !== 'production') return cb(null, true)
    return cb(new Error('Not allowed by CORS: ' + origin))
  }
}))
app.use(express.json())

/* --------------- Utils ---------------- */
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000)
const up = (s='') => (s || '').toString().trim().toUpperCase()
const normalizePlate = (s) => up(String(s).replace(/\s+/g,'')).replace(/[^A-Z0-9]/g,'')

async function one(q) { const r = await q; return r[0] || null }
async function many(q) { return await q }

/* ---- Categorías base + recálculo por services ---- */
async function ensureBaseCategories() {
  const defs = [
    { name: 'ALTA',  everyDays: 30,  description: 'Uso intenso' },
    { name: 'MEDIA', everyDays: 90,  description: 'Uso normal' },
    { name: 'BAJA',  everyDays: 180, description: 'Uso esporádico' },
  ]
  for (const c of defs) {
    await sql`
      INSERT INTO "Category" ("name","everyDays","description","createdAt","updatedAt")
      VALUES (${c.name}, ${c.everyDays}, ${c.description}, NOW(), NOW())
      ON CONFLICT ("name") DO NOTHING
    `
  }
}

async function computeVehicleCategory(plate) {
  const services = await sql`
    SELECT "date" FROM "Service"
    WHERE "vehicleId" = ${plate}
    ORDER BY "date" DESC
    LIMIT 2
  `
  let desired = 'MEDIA'
  if (services.length >= 2) {
    const [last, prev] = services
    const diffDays = Math.ceil((new Date(last.date) - new Date(prev.date)) / 86400000)
    desired = diffDays <= 30 ? 'ALTA' : diffDays <= 90 ? 'MEDIA' : 'BAJA'
  }
  const cat = await one(sql`SELECT * FROM "Category" WHERE "name" = ${desired}`)
  if (!cat) return null
  const lastService = services[0]?.date ?? null
  const nextReminder = lastService ? addDays(lastService, cat.everyDays) : null
  await sql`
    UPDATE "Vehicle"
    SET "categoryId"=${cat.id}, "lastService"=${lastService}, "nextReminder"=${nextReminder}, "updatedAt"=NOW()
    WHERE "plate"=${plate}
  `
  return { category: cat.name, everyDays: cat.everyDays, lastService, nextReminder }
}

/* --------------- ENDPOINTS --------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true }))

/* Clientes */
app.get('/api/clients', async (_req, res) => {
  const rows = await many(sql`SELECT id, name, phone, birthday, notes, "createdAt", "updatedAt" FROM "Client" ORDER BY "name" ASC`)
  res.json(rows)
})

app.post('/api/clients', async (req, res) => {
  const { name, phone, birthday, notes } = req.body
  const row = await one(sql`
    INSERT INTO "Client" ("name","phone","birthday","notes","createdAt","updatedAt")
    VALUES (${name}, ${phone}, ${birthday ? new Date(birthday) : null}, ${notes ?? null}, NOW(), NOW())
    RETURNING id, name, phone, birthday, notes, "createdAt", "updatedAt"`)
  res.status(201).json(row)
})

/* Vehículos (listado con shape que espera el front) */
app.get('/api/vehicles', async (_req, res) => {
  const rows = await many(sql`
    SELECT v.*, 
           cl.id   AS "clientId2", cl.name AS "clientName",
           c.id    AS "categoryId2", c.name AS "categoryName", c."everyDays"
    FROM "Vehicle" v
    JOIN "Client" cl ON cl.id = v."clientId"
    LEFT JOIN "Category" c ON c.id = v."categoryId"
    ORDER BY v."plate" ASC`)

  const shaped = rows.map(r => ({
    plate: r.plate,
    clientId: r.clientId,
    brand: r.brand,
    model: r.model,
    year: r.year,
    categoryId: r.categoryId,
    lastService: r.lastService,
    nextReminder: r.nextReminder,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    client: { id: r.clientId2 ?? r.clientId, name: r.clientName },
    category: r.categoryId2 ? { id: r.categoryId2, name: r.categoryName, everyDays: r.everyDays } : null
  }))
  res.json(shaped)
})

/* Crear vehículo */
app.post('/api/vehicles', async (req, res) => {
  const plate = normalizePlate(req.body.plate)
  const { clientId, brand, model, year, categoryId } = req.body

  const client = await one(sql`SELECT id FROM "Client" WHERE id=${clientId}`)
  if (!client) return res.status(400).json({ error: 'clientId inválido' })

  try {
    const v = await one(sql`
      INSERT INTO "Vehicle" ("plate","clientId","brand","model","year","categoryId","createdAt","updatedAt")
      VALUES (${plate}, ${clientId}, ${brand ?? null}, ${model ?? null}, ${year ?? null}, ${categoryId ?? null}, NOW(), NOW())
      RETURNING *`)
    await computeVehicleCategory(plate)

    // responder con shape igual al GET
    const cat = v.categoryId ? await one(sql`SELECT * FROM "Category" WHERE id=${v.categoryId}`) : null
    const cl  = await one(sql`SELECT id, name FROM "Client" WHERE id=${v.clientId}`)
    return res.status(201).json({
      ...v,
      client: cl ? { id: cl.id, name: cl.name } : null,
      category: cat ? { id: cat.id, name: cat.name, everyDays: cat.everyDays } : null
    })
  } catch (e) {
    if (String(e.message).includes('duplicate key')) return res.status(409).json({ error: 'Patente ya existe' })
    console.error('[POST /api/vehicles]', e)
    res.status(500).json({ error: 'Internal error' })
  }
})

/* Detalle de vehículo + services */
app.get('/api/vehicles/:plate', async (req, res) => {
  const plate = normalizePlate(req.params.plate)
  const v = await one(sql`
    SELECT v.*, 
           cl.id AS "clientId2", cl.name AS "clientName",
           c.id  AS "categoryId2", c.name AS "categoryName", c."everyDays"
    FROM "Vehicle" v
    JOIN "Client" cl ON cl.id = v."clientId"
    LEFT JOIN "Category" c ON c.id = v."categoryId"
    WHERE v."plate"=${plate}`)

  if (!v) return res.status(404).json({ error: 'Not found' })

  const services = await many(sql`
    SELECT id, "vehicleId", "clientId", "date", "odometer", "summary", "createdAt", "updatedAt"
    FROM "Service"
    WHERE "vehicleId"=${plate}
    ORDER BY "date" DESC`)

  res.json({
    plate: v.plate,
    clientId: v.clientId,
    brand: v.brand,
    model: v.model,
    year: v.year,
    categoryId: v.categoryId,
    lastService: v.lastService,
    nextReminder: v.nextReminder,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    client: { id: v.clientId2 ?? v.clientId, name: v.clientName },
    category: v.categoryId2 ? { id: v.categoryId2, name: v.categoryName, everyDays: v.everyDays } : null,
    services
  })
})

/* Agregar service */
app.post('/api/vehicles/:plate/services', async (req, res) => {
  const plate = normalizePlate(req.params.plate)
  const veh = await one(sql`SELECT * FROM "Vehicle" WHERE "plate"=${plate}`)
  if (!veh) return res.status(404).json({ error: 'Vehicle not found' })
  const { date, odometer, summary } = req.body
  const svc = await one(sql`
    INSERT INTO "Service" ("vehicleId","clientId","date","odometer","summary","createdAt","updatedAt")
    VALUES (${plate}, ${veh.clientId}, ${date ? new Date(date) : new Date()}, ${odometer ?? null}, ${summary ?? null}, NOW(), NOW())
    RETURNING *`)
  await computeVehicleCategory(plate)
  res.status(201).json(svc)
})

/* Import CSV (mínimo funcional) */
app.post('/api/import/csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo CSV requerido (file)' })
    const raw = req.file.buffer.toString('utf8')
    const rows = parseCsv(raw, { columns: true, skip_empty_lines: true })
    let createdClients=0, createdVehicles=0, createdServices=0, skippedNoPhone=0, skippedNoPlate=0

    for (const row of rows) {
      const name  = (row.nombre || row['nombre y apellido'] || 'Sin nombre').toString()
      const phone = (row.telefono || row.whatsapp || '').toString().replace(/\D+/g,'')
      const plate = normalizePlate(row.patente || row['patente del vehiculo'] || '')
      if (!phone) { skippedNoPhone++; continue }
      if (!plate) { skippedNoPlate++; continue }

      let client = await one(sql`SELECT * FROM "Client" WHERE phone=${phone}`)
      if (!client) {
        client = await one(sql`
          INSERT INTO "Client" ("name","phone","createdAt","updatedAt")
          VALUES (${name}, ${phone}, NOW(), NOW())
          RETURNING *`)
        createdClients++
      }

      let vehicle = await one(sql`SELECT * FROM "Vehicle" WHERE "plate"=${plate}`)
      if (!vehicle) {
        vehicle = await one(sql`
          INSERT INTO "Vehicle" ("plate","clientId","createdAt","updatedAt")
          VALUES (${plate}, ${client.id}, NOW(), NOW())
          RETURNING *`)
        createdVehicles++
      }

      await sql`
        INSERT INTO "Service" ("vehicleId","clientId","date","createdAt","updatedAt")
        VALUES (${plate}, ${client.id}, NOW(), NOW(), NOW())`
      createdServices++
      await computeVehicleCategory(plate)
    }

    res.json({ createdClients, createdVehicles, createdServices, skippedNoPhone, skippedNoPlate })
  } catch (e) {
    console.error('[IMPORT]', e)
    res.status(400).json({ error: String(e.message || e) })
  }
})

/* Ejecutar scheduler manual (para el botón de Tools) */
app.post('/api/scheduler/run', async (req, res) => {
  const simulate = String(req.query.simulate).toLowerCase() === 'true'
  const result = await (async function run() {
    const vehicles = await sql`
      SELECT v.*, c."everyDays", cl."phone", cl."name" as "clientName"
      FROM "Vehicle" v
      LEFT JOIN "Category" c ON c.id = v."categoryId"
      JOIN "Client" cl ON cl.id = v."clientId"`
    let sent = 0, errors = 0
    for (const v of vehicles) {
      await computeVehicleCategory(v.plate)
      const updated = await one(sql`
        SELECT v.*, c."everyDays", cl."phone", cl."name" as "clientName"
        FROM "Vehicle" v
        LEFT JOIN "Category" c ON c.id = v."categoryId"
        JOIN "Client" cl ON cl.id = v."clientId"
        WHERE v."plate"=${v.plate}`)
      if (updated?.nextReminder && new Date(updated.nextReminder) <= new Date()) {
        try {
          if (!simulate) {
            // acá iría WhatsApp real si lo activás
          } else {
            console.log('[Simulado] Aviso →', updated.phone, updated.plate)
          }
          sent++
          const days = updated.everyDays ?? 90
          await sql`UPDATE "Vehicle" SET "nextReminder"=${addDays(new Date(), days)} WHERE "plate"=${updated.plate}`
        } catch (e) { console.error(e.message); errors++ }
      }
    }
    return { sent, errors }
  })()
  res.json(result)
})

/* Arranque */
const port = Number(process.env.PORT || 4000)
app.listen(port, () => console.log(`API listening → http://localhost:${port}`))
