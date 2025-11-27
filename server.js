// server.js
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

// Helpers para consultas
const many = async (q) => q
const one = async (q) => {
  const rows = await q
  return rows[0] || null
}

// ------------------------
// Middlewares
// ------------------------
app.use(cors())
app.use(bodyParser.json())

// ------------------------
// Helpers de dominio
// ------------------------
function normalizePlate(plate) {
  if (!plate) return null
  return String(plate).toUpperCase().replace(/\s+/g, '')
}

// Este helper lo dejo como stub, en tu proyecto probablemente
// ya tengas una implementación más completa.
// Si es así, conservá TU versión original.
async function computeVehicleCategory(plate) {
  // Ejemplo simple (puedes reemplazar por tu lógica original)
  // Aquí podrías:
  // - Buscar último service del vehículo
  // - Mirar categoría y everyDays
  // - Calcular nextReminder y actualizar Vehicle
  return
}

// ------------------------
// Endpoints básicos
// ------------------------
app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

/**
 * CLIENTES
 * (Ejemplo muy simple, adaptá a tu server real si ya lo tenés)
 */
app.get('/api/clients', async (_req, res) => {
  try {
    const rows = await many(sql`
      SELECT id, name, phone, email, createdAt, updatedAt
      FROM "Client"
      ORDER BY "name" ASC`)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener clientes' })
  }
})

/**
 * CATEGORÍAS
 */
app.get('/api/categories', async (_req, res) => {
  try {
    const rows = await many(sql`
      SELECT id, name, "everyDays", createdAt, updatedAt
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

/**
 * GET /api/vehicles
 * Ahora permite vehículos SIN cliente (LEFT JOIN)
 */
app.get('/api/vehicles', async (_req, res) => {
  try {
    const rows = await many(sql`
      SELECT v.*, 
             cl.id   AS "clientId2", cl.name AS "clientName",
             c.id    AS "categoryId2", c.name AS "categoryName", c."everyDays"
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
        ? { id: r.clientId2, name: r.clientName }
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

/**
 * GET /api/vehicles/:plate
 * También permite vehículo sin cliente (LEFT JOIN)
 */
app.get('/api/vehicles/:plate', async (req, res) => {
  try {
    const plate = normalizePlate(req.params.plate)
    if (!plate) return res.status(400).json({ error: 'Patente inválida' })

    const v = await one(sql`
      SELECT v.*, 
             cl.id AS "clientId2", cl.name AS "clientName",
             c.id  AS "categoryId2", c.name AS "categoryName", c."everyDays"
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
        ? { id: v.clientId2, name: v.clientName }
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

/**
 * POST /api/vehicles
 * Ahora clientId es OPCIONAL.
 * - Si viene vacío / null → se guarda null.
 * - Si viene con valor → se valida que exista el cliente.
 */
app.post('/api/vehicles', async (req, res) => {
  try {
    const plate = normalizePlate(req.body.plate)
    let { clientId, brand, model, year, categoryId } = req.body

    if (!plate) {
      return res.status(400).json({ error: 'Patente requerida' })
    }

    // Normalizar clientId a número o null
    const clientIdNormalized =
      clientId === undefined || clientId === null || clientId === ''
        ? null
        : Number(clientId)

    // Validar cliente solo si viene algo
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

    // Recalcular info de categoría / recordatorios si aplica
    await computeVehicleCategory(plate)

    // Traer cliente y categoría para responder con el mismo formato que el GET
    const row = await one(sql`
      SELECT v.*,
             cl.id AS "clientId2", cl.name AS "clientName",
             c.id  AS "categoryId2", c.name AS "categoryName", c."everyDays"
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
        ? { id: row.clientId2, name: row.clientName }
        : null,
      category: row.categoryId2
        ? { id: row.categoryId2, name: row.categoryName, everyDays: row.everyDays }
        : null
    }

    res.status(201).json(response)
  } catch (err) {
    console.error(err)
    if (err && err.code === '23505') {
      // unique_violation (patente duplicada)
      return res.status(400).json({ error: 'Ya existe un vehículo con esa patente' })
    }
    res.status(500).json({ error: 'Error al crear vehículo' })
  }
})

/**
 * Servicios (ejemplo muy simple)
 * En tu proyecto probablemente esto ya esté más completo.
 */
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

    // Podés querer recomputar recordatorios al cargar un service
    await computeVehicleCategory(vehicleId)

    res.status(201).json(service)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al crear service' })
  }
})

// ------------------------
// Arranque del servidor
// ------------------------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
