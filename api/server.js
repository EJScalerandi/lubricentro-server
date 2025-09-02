import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cron from 'node-cron'
import multer from 'multer'
import { parse as parseCsv } from 'csv-parse/sync'
import { neon, neonConfig } from '@neondatabase/serverless'

neonConfig.fetchConnectionCache = true
const sql = neon(process.env.DATABASE_URL)

const app = express()
const upload = multer({ storage: multer.memoryStorage() })

// ---- CORS ----
const allowed = (process.env.CLIENT_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true)
    if (process.env.NODE_ENV !== 'production') return cb(null, true)
    return cb(new Error('Not allowed by CORS: ' + origin))
  }
}))
app.use(express.json())

// ---------- Utils ----------
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000)
const up = (s='') => (s || '').toString().trim().toUpperCase()
const onlyDigits = (s='') => (s || '').toString().replace(/\D+/g, '')
const stripDiacritics = (s='') => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const normKey = (k='') => stripDiacritics(k).toLowerCase().replace(/\s+/g,' ')
function findKey(obj, hints) { for (const k of Object.keys(obj||{})) { const nk = normKey(k); if (hints.some(h => nk.includes(h))) return k } return null }
function detectDelimiter(raw) {
  const firstLine = raw.split(/\r?\n/,1)[0] || ''
  const counts = [',',';','\t'].map(d => ({ d, c: (firstLine.match(new RegExp(`\\${d}`,'g'))||[]).length }))
  counts.sort((a,b)=>b.c-a.c)
  return (counts[0]?.c ?? 0) > 0 ? counts[0].d : ','
}
function tryParseCsv(raw) {
  const delim = detectDelimiter(raw)
  return parseCsv(raw, { columns:true, skip_empty_lines:true, delimiter:delim, bom:true, relax_quotes:true, relax_column_count:true, trim:true })
}
function parseIntLoose(s) {
  if (s == null) return null
  const n = parseInt(String(s).replace(/[^0-9]/g,''), 10)
  if (!Number.isFinite(n) || n < 0 || n > 3_000_000) return null
  return n
}
function parseMoney(s) { if (!s) return null; const t=String(s).replace(/\./g,'').replace(/,/g,'.').replace(/\s/g,''); const n=Number(t); return Number.isFinite(n)?n:null }
function fixWeirdDate(s) {
  if (!s) return null
  let t = String(s).trim()
  if (/^002\d-/.test(t)) t = t.replace(/^002/, '202')
  t = t.replace(/a\.\s*m\./ig,'AM').replace(/p\.\s*m\./ig,'PM').replace(/\s*GMT[-+]\d+\s*$/i,'')
  const d = new Date(t)
  return isNaN(d) ? null : d
}
const normalizePlate = (s) => up(String(s).replace(/\s+/g,'')).replace(/[^A-Z0-9]/g,'')

// ---------- DB helpers ----------
async function one(q) { const r = await q; return r[0] || null }
async function many(q) { return await q }

// ---------- Categorías (seed opcional) + recálculo ----------
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

// ---------- WhatsApp (simulado si faltan credenciales) ----------
async function sendWhatsApp({ phone, name, nextDate }) {
  if (process.env.WHATSAPP_ENABLED !== 'true') {
    console.log('[Simulado] WhatsApp →', phone, name, nextDate)
    return { simulated: true }
  }
  const token = process.env.WHATSAPP_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const template = process.env.WHATSAPP_TEMPLATE || 'service_reminder'
  const lang = process.env.WHATSAPP_TEMPLATE_LANG || 'es'
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`
  const body = {
    messaging_product: 'whatsapp',
    to: (phone || '').replace(/\D/g, ''),
    type: 'template',
    template: {
      name: template, language: { code: lang },
      components: [{ type:'body', parameters:[
        { type:'text', text: name || '' },
        { type:'text', text: nextDate ? new Date(nextDate).toLocaleDateString() : '' },
      ]}]
    }
  }
  const res = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`[WhatsApp] ${res.status} ${await res.text()}`)
  return res.json()
}

// ---------- Scheduler ----------
async function runScheduler({ simulate = false } = {}) {
  const vehicles = await sql`
    SELECT v.*, c."everyDays", cl."phone", cl."name" as "clientName"
    FROM "Vehicle" v
    LEFT JOIN "Category" c ON c.id = v."categoryId"
    JOIN "Client" cl ON cl.id = v."clientId"
  `
  let sent = 0, errors = 0
  for (const v of vehicles) {
    await computeVehicleCategory(v.plate)
    const updated = await one(sql`
      SELECT v.*, c."everyDays", cl."phone", cl."name" as "clientName"
      FROM "Vehicle" v
      LEFT JOIN "Category" c ON c.id = v."categoryId"
      JOIN "Client" cl ON cl.id = v."clientId"
      WHERE v."plate"=${v.plate}
    `)
    if (updated?.nextReminder && new Date(updated.nextReminder) <= new Date()) {
      try {
        if (!simulate) {
          await sendWhatsApp({ phone: updated.phone, name: updated.clientName, nextDate: updated.nextReminder })
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
}

if (!process.env.VERCEL) {
  cron.schedule(process.env.CRON_EXPR || '0 9 * * *', () => {
    runScheduler().then(r => console.log('[CRON]', r)).catch(console.error)
  })
}

// ---------- Endpoints ----------
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// Seed categorías (opcional)
app.post('/api/categories/seed', async (_req, res) => {
  await ensureBaseCategories()
  res.json({ ok: true })
})

// Categorías
app.get('/api/categories', async (_req, res) => {
  const rows = await many(sql`SELECT * FROM "Category" ORDER BY "name" ASC`)
  res.json(rows)
})
app.post('/api/categories', async (req, res) => {
  const { name, everyDays, description } = req.body
  const row = await one(sql`
    INSERT INTO "Category" ("name","everyDays","description","createdAt","updatedAt")
    VALUES (${name}, ${everyDays}, ${description ?? null}, NOW(), NOW())
    RETURNING *
  `)
  res.status(201).json(row)
})

// Clientes
app.get('/api/clients', async (_req, res) => {
  const rows = await many(sql`SELECT * FROM "Client" ORDER BY "name" ASC`)
  res.json(rows)
})
app.get('/api/clients/:id', async (req, res) => {
  const id = Number(req.params.id)
  const client = await one(sql`SELECT * FROM "Client" WHERE id=${id}`)
  if (!client) return res.status(404).json({ error: 'Not found' })
  const vehicles = await many(sql`
    SELECT v.*, c."name" AS "categoryName", c."everyDays"
    FROM "Vehicle" v
    LEFT JOIN "Category" c ON c.id = v."categoryId"
    WHERE v."clientId"=${id}
    ORDER BY v."plate" ASC
  `)
  const services = await many(sql`
    SELECT * FROM "Service" WHERE "clientId"=${id} ORDER BY "date" DESC
  `)
  res.json({ ...client, vehicles, services })
})
app.post('/api/clients', async (req, res) => {
  const { name, phone, birthday, notes } = req.body
  const row = await one(sql`
    INSERT INTO "Client" ("name","phone","birthday","notes","createdAt","updatedAt")
    VALUES (${name}, ${phone}, ${birthday ? new Date(birthday) : null}, ${notes ?? null}, NOW(), NOW())
    RETURNING *
  `)
  res.status(201).json(row)
})

// Vehículos
app.get('/api/vehicles', async (_req, res) => {
  const rows = await many(sql`
    SELECT v.*, cl."name" AS "clientName", c."name" AS "categoryName", c."everyDays"
    FROM "Vehicle" v
    JOIN "Client" cl ON cl.id = v."clientId"
    LEFT JOIN "Category" c ON c.id = v."categoryId"
    ORDER BY v."plate" ASC
  `)
  res.json(rows)
})
app.get('/api/vehicles/:plate', async (req, res) => {
  const plate = up(req.params.plate)
  const v = await one(sql`
    SELECT v.*, cl."name" AS "clientName", c."name" AS "categoryName", c."everyDays"
    FROM "Vehicle" v
    JOIN "Client" cl ON cl.id = v."clientId"
    LEFT JOIN "Category" c ON c.id = v."categoryId"
    WHERE v."plate"=${plate}
  `)
  if (!v) return res.status(404).json({ error: 'Not found' })
  const services = await many(sql`
    SELECT * FROM "Service" WHERE "vehicleId"=${plate} ORDER BY "date" DESC
  `)
  res.json({ ...v, services })
})
app.post('/api/vehicles', async (req, res) => {
  const { plate, clientId, brand, model, year, categoryId } = req.body
  const row = await one(sql`
    INSERT INTO "Vehicle" ("plate","clientId","brand","model","year","categoryId","createdAt","updatedAt")
    VALUES (${up(plate)}, ${clientId}, ${brand ?? null}, ${model ?? null}, ${year ?? null}, ${categoryId ?? null}, NOW(), NOW())
    RETURNING *
  `)
  res.status(201).json(row)
})

// Services
app.get('/api/vehicles/:plate/services', async (req, res) => {
  const plate = up(req.params.plate)
  const list = await many(sql`
    SELECT * FROM "Service" WHERE "vehicleId"=${plate} ORDER BY "date" DESC
  `)
  res.json(list)
})
app.post('/api/vehicles/:plate/services', async (req, res) => {
  const plate = up(req.params.plate)
  const veh = await one(sql`SELECT * FROM "Vehicle" WHERE "plate"=${plate}`)
  if (!veh) return res.status(404).json({ error: 'Vehicle not found' })
  const { date, odometer, summary } = req.body
  const svc = await one(sql`
    INSERT INTO "Service" ("vehicleId","clientId","date","odometer","summary","createdAt","updatedAt")
    VALUES (${plate}, ${veh.clientId}, ${date ? new Date(date) : new Date()}, ${odometer ?? null}, ${summary ?? null}, NOW(), NOW())
    RETURNING *
  `)
  await computeVehicleCategory(plate)
  res.status(201).json(svc)
})

// Import CSV
app.post('/api/import/csv', upload.single('file'), async (req,res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo CSV requerido (file)' })
    const raw = req.file.buffer.toString('utf8')
    const rows = tryParseCsv(raw)
    let createdClients=0, createdVehicles=0, createdServices=0, skippedNoPhone=0, skippedNoPlate=0

    for (const row of rows) {
      const kTime   = findKey(row, ['marca temporal'])
      const kFecha  = findKey(row, ['fecha'])
      const kNombre = findKey(row, ['nombre y apellido','nombre'])
      const kPat    = findKey(row, ['patente del vehiculo','patente del vehículo','patente'])
      const kVeh    = findKey(row, ['marca, modelo y ano del vehiculo','marca, modelo y año del vehiculo','marca modelo ano'])
      const kWhats  = findKey(row, ['whatsapp','telefono','tel'])
      const kKm     = findKey(row, ['cantidad de kilometros','km','kilometros'])
      const kAceite = findKey(row, ['aceite'])
      const kFAce   = findKey(row, ['filtro de aceite'])
      const kFAir   = findKey(row, ['filtro de aire'])
      const kFComb  = findKey(row, ['filtro de combustible'])
      const kFHab   = findKey(row, ['filtro de habitaculo','filtro de habitáculo'])
      const kOtros  = findKey(row, ['otros servicios','otros'])
      const kPrecio = findKey(row, ['precio final del cambio','precio'])
      const kEmail  = findKey(row, ['@','email','correo'])

      const name = (row[kNombre] ?? '').toString().trim() || 'Sin nombre'
      const phone = onlyDigits(row[kWhats] ?? '')
      if (!phone) { skippedNoPhone++; continue }

      const svcDate = fixWeirdDate(row[kFecha]) || fixWeirdDate(row[kTime]) || new Date()
      const plateRaw = row[kPat]
      const plate = normalizePlate(plateRaw || '')
      if (!plate) { skippedNoPlate++; continue }

      let client = await one(sql`SELECT * FROM "Client" WHERE "phone"=${phone}`)
      const maybeEmail = (row[kEmail] ?? '').toString().trim()
      if (!client) {
        client = await one(sql`
          INSERT INTO "Client" ("name","phone","notes","createdAt","updatedAt")
          VALUES (${name}, ${phone}, ${maybeEmail || null}, NOW(), NOW())
          RETURNING *
        `)
        createdClients++
      } else if (!client.notes && maybeEmail) {
        await sql`UPDATE "Client" SET "notes"=${maybeEmail}, "updatedAt"=NOW() WHERE id=${client.id}`
      }

      let vehicle = await one(sql`SELECT * FROM "Vehicle" WHERE "plate"=${plate}`)
      if (!vehicle) {
        let brand=null, model=null, year=null
        if (kVeh) {
          const val = (row[kVeh] ?? '').toString()
          const parts = val.split(/[,\s]+/).filter(Boolean)
          if (parts.length >= 1) brand = parts[0]
          if (parts.length >= 2) model = parts.slice(1).filter(p=>!/^\d{4}$/.test(p)).join(' ') || null
          const y = parts.find(p => /^\d{4}$/.test(p)); if (y) year = parseInt(y,10)
        }
        vehicle = await one(sql`
          INSERT INTO "Vehicle" ("plate","clientId","brand","model","year","createdAt","updatedAt")
          VALUES (${plate}, ${client.id}, ${brand}, ${model}, ${year ?? null}, NOW(), NOW())
          RETURNING *
        `)
        createdVehicles++
      }

      const odometer = parseIntLoose(row[kKm])
      const parts = []
      if (kAceite && row[kAceite]) parts.push(`Aceite: ${row[kAceite]}`)
      if (kFAce && row[kFAce])     parts.push(`Filtro aceite: ${row[kFAce]}`)
      if (kFAir && row[kFAir])     parts.push(`Filtro aire: ${row[kFAir]}`)
      if (kFComb && row[kFComb])   parts.push(`Filtro combustible: ${row[kFComb]}`)
      if (kFHab && row[kFHab])     parts.push(`Filtro habitáculo: ${row[kFHab]}`)
      if (kOtros && row[kOtros])   parts.push(`Otros: ${row[kOtros]}`)
      const precio = parseMoney(row[kPrecio]); if (precio != null) parts.push(`Precio: ${precio}`)
      const summary = parts.join(' | ') || null

      await sql`
        INSERT INTO "Service" ("vehicleId","clientId","date","odometer","summary","createdAt","updatedAt")
        VALUES (${plate}, ${client.id}, ${svcDate}, ${odometer ?? null}, ${summary}, NOW(), NOW())
      `
      createdServices++
      await computeVehicleCategory(plate)
    }
    res.json({ createdClients, createdVehicles, createdServices, skippedNoPhone, skippedNoPlate })
  } catch (e) { console.error('[IMPORT]', e); res.status(400).json({ error: String(e.message || e) }) }
})

// Scheduler manual (Vercel Cron)
app.post('/api/scheduler/run', async (req, res) => {
  const out = await runScheduler({ simulate: req.query.simulate === 'true' })
  res.json(out)
})

export default app
