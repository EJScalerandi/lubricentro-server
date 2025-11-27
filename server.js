// server.cjs
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const postgres = require('postgres')

const app = express()
const PORT = process.env.PORT || 3001

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

// Stub: reemplazá por tu lógica real si ya la tenías
async function computeVehicleCategory(_plate) {
  return
}

// ------------------------
// Middlewares
// ------------------------
app.use(cors())
app.use(bodyParser.json())

// ------------------------
// Health
// ------------------------
app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

// ------------------------
// CLIENTES
// ------------------------
app.get('/api/clients', async (_req, res) => {
  try {
    const rows = await many(sql`
      SELECT id, name, phone, email, "createdAt", "updatedAt"
      FROM "Client"
      ORDER BY "name" ASC`)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener clientes' })
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

// GET /api/vehicles – ahora incluye info de cliente (incl. phone) y permite sin cliente
app.get('/api/vehicles', async (_req, res) => {
  try {
    const rows = await many(sql`
      SELECT v.*, 
             cl.id    AS "clientId2",
             cl.name  AS "clientName",
             cl.phone AS "clientPhone",
             c.id     AS "categoryId2",
             c.name   AS "categoryName",
             c."everyDays"
      FROM "Vehicle" v
      LEFT JOIN "Client"   cl ON cl.id = v."clientId"
      LEFT JOIN "Category" c  ON c.id = v."categoryId"
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
      client: r.clientId2
        ? { id: r.clientId2, name: r.clientName, phone: r.clientPhone }
        : null,
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

// GET /api/vehicles/:plate – detalle (también permite sin cliente)
app.get('/api/vehicles/:plate', async (req, res) => {
  try {
    const plate = normalizePlate(req.params.plate)
    if (!plate) return res.status(400).json({ error: 'Patente inválida' })

    const v = await one(sql`
      SELECT v.*, 
             cl.id    AS "clientId2",
             cl.name  AS "clientName",
             cl.phone AS "clientPhone",
             c.id     AS "categoryId2",
             c.name   AS "categoryName",
             c."everyDays"
      FROM "Vehicle" v
      LEFT JOIN "Client"   cl ON cl.id = v."clientId"
      LEFT JOIN "Category" c  ON c.id = v."categoryId"
      WHERE v."plate" = ${plate}`)

    if (!v) return res.status(404).json({ error: 'Not found' })

    const services = await many(sql`
      SELECT id, "vehicleId", "clientId", "date", "odometer", "summary", "createdAt", "updatedAt"
      FROM "Service"
      WHERE "vehicleId" = ${plate}
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
      client: v.clientId2
        ? { id: v.clientId2, name: v.clientName, phone: v.clientPhone }
        : null,
      category: v.categoryId2
        ? { id: v.categoryId2, name: v.categoryName, everyDays: v.everyDays }
        : null,
      services
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener vehículo' })
  }
})

// POST /api/vehicles – clientId opcional
app.post('/api/vehicles', async (req, res) => {
  try {
    const plate = normalizePlate(req.body.plate)
    const { brand, model, year, categoryId } = req.body
    let { clientId } = req.body

    if (!plate) {
      return res.status(400).json({ error: 'Patente requerida' })
    }

    const clientIdNormalized =
      clientId === undefined || clientId === null || clientId === ''
        ? null
        : Number(clientId)

    if (clientIdNormalized !== null) {
      const client = await one(sql`SELECT id FROM "Client" WHERE id = ${clientIdNormalized}`)
      if (!client) {
        return res.status(400).json({ error: 'clientId inválido' })
      }
    }

    const v = await one(sql`
      INSERT INTO "Vehicle"
        ("plate", "clientId", "brand", "model", "year", "categoryId", "createdAt", "updatedAt")
      VALUES (
        ${plate},
        ${clientIdNormalized},
        ${brand ?? null},
        ${model ?? null},
        ${year ?? null},
        ${categoryId ?? null},
        NOW(),
        NOW()
      )
      RETURNING *`)

    await computeVehicleCategory(plate)

    const row = await one(sql`
      SELECT v.*,
             cl.id    AS "clientId2",
             cl.name  AS "clientName",
             cl.phone AS "clientPhone",
             c.id     AS "categoryId2",
             c.name   AS "categoryName",
             c."everyDays"
      FROM "Vehicle" v
      LEFT JOIN "Client"   cl ON cl.id = v."clientId"
      LEFT JOIN "Category" c  ON c.id = v."categoryId"
      WHERE v."plate" = ${plate}`)

    const response = {
      plate: row.plate,
      clientId: row.clientId,
      brand: row.brand,
      model: row.model,
      year: row.year,
      categoryId: row.categoryId,
      lastService: row.lastService,
      nextReminder: row.nextReminder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      client: row.clientId2
        ? { id: row.clientId2, name: row.clientName, phone: row.clientPhone }
        : null,
      category: row.categoryId2
        ? { id: row.categoryId2, name: row.categoryName, everyDays: row.everyDays }
        : null
    }

    res.status(201).json(response)
  } catch (err) {
    console.error(err)
    if (err && err.code === '23505') {
      return res.status(400).json({ error: 'Ya existe un vehículo con esa patente' })
    }
    res.status(500).json({ error: 'Error al crear vehículo' })
  }
})

// ------------------------
// SERVICES (ejemplo simple)
// ------------------------
app.post('/api/services', async (req, res) => {
  try {
    const { vehicleId, clientId, date, odometer, summary } = req.body
    if (!vehicleId || !date) {
      return res.status(400).json({ error: 'vehicleId y date son obligatorios' })
    }

    const service = await one(sql`
      INSERT INTO "Service"
        ("vehicleId", "clientId", "date", "odometer", "summary", "createdAt", "updatedAt")
      VALUES (
        ${vehicleId},
        ${clientId ?? null},
        ${date},
        ${odometer ?? null},
        ${summary ?? null},
        NOW(),
        NOW()
      )
      RETURNING *`)

    await computeVehicleCategory(vehicleId)

    res.status(201).json(service)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al crear service' })
  }
})

// --------------------------------------------------
// MESSAGE TEMPLATE (PLANTILLAS DE MENSAJE)
// Tabla: "MessageTemplate"
// --------------------------------------------------

// GET lista
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

// GET una
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

// POST crear
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

// PUT actualizar
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

// DELETE eliminar
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
