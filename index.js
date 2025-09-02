import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cron from 'node-cron'
import multer from 'multer'
import { parse as parseCsv } from 'csv-parse/sync'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const app = express()
const upload = multer({ storage: multer.memoryStorage() })

// ---- CORS (permite CLIENT_ORIGIN y fallback a *) ----
const allowed = (process.env.CLIENT_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true) // curl/postman
    if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true)
    if (process.env.NODE_ENV !== 'production') return cb(null, true) // en dev, relajado
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
  if (/^002\d-/.test(t)) t = t.replace(/^002/, '202') // 0024- → 2024-
  t = t.replace(/a\.\s*m\./ig,'AM').replace(/p\.\s*m\./ig,'PM').replace(/\s*GMT[-+]\d+\s*$/i,'')
  const d = new Date(t)
  return isNaN(d) ? null : d
}
const normalizePlate = (s) => up(String(s).replace(/\s+/g,'')).replace(/[^A-Z0-9]/g,'')

// ---------- Categorías (seed opcional) + recálculo ----------
async function ensureBaseCategories() {
  const defs = [
    { name: 'ALTA',  everyDays: 30,  description: 'Uso intenso' },
    { name: 'MEDIA', everyDays: 90,  description: 'Uso normal' },
    { name: 'BAJA',  everyDays: 180, description: 'Uso esporádico' },
  ]
  for (const c of defs) {
    await prisma.category.upsert({ where: { name: c.name }, create: c, update: {} })
  }
}
async function computeVehicleCategory(plate) {
  const services = await prisma.service.findMany({ where: { vehicleId: plate }, orderBy: { date: 'desc' }, take: 2 })
  let desired = 'MEDIA'
  if (services.length >= 2) {
    const [last, prev] = services
    const diffDays = Math.ceil((new Date(last.date) - new Date(prev.date)) / 86400000)
    desired = diffDays <= 30 ? 'ALTA' : diffDays <= 90 ? 'MEDIA' : 'BAJA'
  }
  const cat = await prisma.category.findUnique({ where: { name: desired } })
  if (!cat) return null
  const lastService = services[0]?.date ?? null
  const nextReminder = lastService ? addDays(lastService, cat.everyDays) : null
  await prisma.vehicle.update({ where: { plate }, data: { categoryId: cat.id, lastService, nextReminder } })
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
  const vehicles = await prisma.vehicle.findMany({ include: { client: true, category: true } })
  let sent = 0, errors = 0
  for (const v of vehicles) {
    await computeVehicleCategory(v.plate)
    const updated = await prisma.vehicle.findUnique({ where: { plate: v.plate }, include: { client: true, category: true } })
    if (updated?.nextReminder && new Date(updated.nextReminder) <= new Date()) {
      try {
        if (!simulate) {
          await sendWhatsApp({ phone: updated.client.phone, name: updated.client.name, nextDate: updated.nextReminder })
        } else {
          console.log('[Simulado] Aviso →', updated.client.phone, updated.plate)
        }
        sent++
        const days = updated.category?.everyDays ?? 90
        await prisma.vehicle.update({ where: { plate: updated.plate }, data: { nextReminder: addDays(new Date(), days) } })
      } catch (e) { console.error(e.message); errors++ }
    }
  }
  return { sent, errors }
}

// En Vercel no hay proceso persistente → no agendamos cron.
// Usá un Cron Job de Vercel que pegue a /api/scheduler/run
if (!process.env.VERCEL) {
  cron.schedule(process.env.CRON_EXPR || '0 9 * * *', () => {
    runScheduler().then(r => console.log('[CRON]', r)).catch(console.error)
  })
}

// ---------- Endpoints ----------
app.get('/api/health', (_, res) => res.json({ ok: true }))

// Categorías
app.get('/api/categories', async (_, res) => { res.json(await prisma.category.findMany({ orderBy: { name: 'asc' } })) })
app.post('/api/categories', async (req, res) => {
  const { name, everyDays, description } = req.body
  const c = await prisma.category.create({ data: { name, everyDays, description: description || null } })
  res.status(201).json(c)
})

// Clientes
app.get('/api/clients', async (_, res) => { res.json(await prisma.client.findMany({ orderBy: { name: 'asc' } })) })
app.get('/api/clients/:id', async (req, res) => {
  const id = Number(req.params.id)
  const c = await prisma.client.findUnique({
    where: { id },
    include: { vehicles: { include: { category: true, services: { orderBy: { date: 'desc' } } } }, services: true }
  })
  if (!c) return res.status(404).json({ error: 'Not found' })
  res.json(c)
})
app.post('/api/clients', async (req, res) => {
  const { name, phone, birthday, notes } = req.body
  const c = await prisma.client.create({ data: { name, phone, birthday: birthday ? new Date(birthday) : null, notes: notes || null } })
  res.status(201).json(c)
})

// Vehículos
app.get('/api/vehicles', async (_, res) => {
  const v = await prisma.vehicle.findMany({ include: { client: true, category: true }, orderBy: { plate: 'asc' } })
  res.json(v)
})
app.get('/api/vehicles/:plate', async (req, res) => {
  const plate = up(req.params.plate)
  const v = await prisma.vehicle.findUnique({ where: { plate }, include: { client: true, category: true, services: { orderBy: { date: 'desc' } } } })
  if (!v) return res.status(404).json({ error: 'Not found' })
  res.json(v)
})
app.post('/api/vehicles', async (req, res) => {
  const { plate, clientId, brand, model, year, categoryId } = req.body
  const v = await prisma.vehicle.create({ data: { plate: up(plate), clientId, brand, model, year: year ?? null, categoryId: categoryId ?? null } })
  res.status(201).json(v)
})

// Services
app.get('/api/vehicles/:plate/services', async (req, res) => {
  const plate = up(req.params.plate)
  const list = await prisma.service.findMany({ where: { vehicleId: plate }, orderBy: { date: 'desc' } })
  res.json(list)
})
app.post('/api/vehicles/:plate/services', async (req, res) => {
  const plate = up(req.params.plate)
  const veh = await prisma.vehicle.findUnique({ where: { plate } })
  if (!veh) return res.status(404).json({ error: 'Vehicle not found' })
  const { date, odometer, summary } = req.body
  const s = await prisma.service.create({
    data: { vehicleId: plate, clientId: veh.clientId, date: date ? new Date(date) : new Date(), odometer: odometer ?? null, summary: summary || null }
  })
  await computeVehicleCategory(plate)
  res.status(201).json(s)
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

      let client = await prisma.client.findUnique({ where: { phone } })
      const maybeEmail = (row[kEmail] ?? '').toString().trim()
      if (!client) { client = await prisma.client.create({ data: { name, phone, notes: maybeEmail || null } }); createdClients++ }
      else if (!client.notes && maybeEmail) { await prisma.client.update({ where: { id: client.id }, data: { notes: maybeEmail } }) }

      let vehicle = await prisma.vehicle.findUnique({ where: { plate } })
      if (!vehicle) {
        let brand=null, model=null, year=null
        if (kVeh) {
          const val = (row[kVeh] ?? '').toString()
          const parts = val.split(/[,\s]+/).filter(Boolean)
          if (parts.length >= 1) brand = parts[0]
          if (parts.length >= 2) model = parts.slice(1).filter(p=>!/^\d{4}$/.test(p)).join(' ') || null
          const y = parts.find(p => /^\d{4}$/.test(p)); if (y) year = parseInt(y,10)
        }
        vehicle = await prisma.vehicle.create({ data: { plate, clientId: client.id, brand, model, year: year ?? null } })
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

      await prisma.service.create({ data: { vehicleId: plate, clientId: client.id, date: svcDate, odometer, summary } })
      createdServices++
      await computeVehicleCategory(plate)
    }
    res.json({ createdClients, createdVehicles, createdServices, skippedNoPhone, skippedNoPlate })
  } catch (e) { console.error('[IMPORT]', e); res.status(400).json({ error: String(e.message || e) }) }
})

// Scheduler manual (compatible con Vercel Cron)
app.post('/api/scheduler/run', async (req, res) => {
  const out = await runScheduler({ simulate: req.query.simulate === 'true' })
  res.json(out)
})

// ---------- Export para Vercel + arranque local ----------
const port = Number(process.env.PORT || 4000)

// Exporto para Serverless (Vercel)
export default app

// Solo escuchar en local
if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`API http://localhost:${port}`))
}
