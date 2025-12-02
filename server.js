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

// Recalcula lastService y nextReminder para un vehículo
async function computeVehicleCategory(plate) {
  if (!plate) return
  try {
    await one(sql`
      UPDATE "Vehicle" v
      SET
        "lastService" = sub.last_service,
        "nextReminder" = CASE
          WHEN sub.last_service IS NOT NULL AND c."everyDays" IS NOT NULL
            THEN sub.last_service + (c."everyDays" || ' days')::interval
          ELSE NULL
        END,
        "updatedAt" = NOW()
      FROM (
        SELECT MAX(s."date") AS last_service
        FROM "Service" s
        WHERE s."vehicleId" = ${plate}
      ) sub
      LEFT JOIN "Category" c ON c.id = v."categoryId"
      WHERE v."plate" = ${plate}
      RETURNING v."plate"
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
// (de momento SOLO se usa si el front manda Authorization: Bearer xxx,
// no bloqueamos las rutas viejas para no romper nada)
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || ''
  const [type, token] = auth.split(' ')
  if (!token || type !== 'Bearer') {
    // si no hay token, simplemente seguimos (el front se encarga de no mostrar las pantallas protegidas)
    return next()
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.user = payload
    return next()
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' })
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
// Tabla users: id, username, password_hash, created_at, updated_at
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ error: 'username y password son requeridos' })
    }

    const user = await one(sql`
      SELECT id, username, password_hash
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
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    )

    res.json({ token })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al hacer login' })
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
// VEHÍCULOS (sin Client, con contactName/contactPhone)
// --------------------------------------------------

// GET /api/vehicles – incluye info de categoría y fecha del último service
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
      lastService: r.lastService,      // ya viene calculado por computeVehicleCategory
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
        c.id   AS "categoryId2",
        c.name AS "categoryName",
        c."everyDays"
      FROM "Vehicle" v
      LEFT JOIN "Category" c ON c.id = v."categoryId"
      WHERE v."plate" = ${plate}`)

    if (!v) return res.status(404).json({ error: 'Not found' })

    const services = await many(sql`
      SELECT id, "vehicleId", "date", "odometer", "summary",
             "oil", "filterOil", "filterAir", "filterFuel", "filterCabin",
             "otherServices", "totalPrice",
             "createdAt", "updatedAt"
      FROM "Service"
      WHERE "vehicleId" = ${plate}
      ORDER BY "date" DESC`)

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
      services
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

// PUT /api/vehicles/:plate – actualizar datos básicos + contacto
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
      contactPhone
    } = req.body

    const vehicle = await one(sql`
      UPDATE "Vehicle"
      SET "brand"        = ${brand ?? null},
          "model"        = ${model ?? null},
          "year"         = ${year ?? null},
          "categoryId"   = ${categoryId ?? null},
          "contactName"  = ${contactName ?? null},
          "contactPhone" = ${contactPhone ?? null},
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

// GET /api/services?from=YYYY-MM-DD&to=YYYY-MM-DD
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
        v."contactPhone" AS "contactPhone"
      FROM "Service" s
      LEFT JOIN "Vehicle" v ON v."plate" = s."vehicleId"
      WHERE ${where}
      ORDER BY s."date" DESC, s.id DESC
    `)

    const shaped = rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicleId,
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
      }
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
      totalPrice
    } = req.body

    if (!vehicleId || !date) {
      return res.status(400).json({ error: 'vehicleId y date son obligatorios' })
    }

    const service = await one(sql`
      INSERT INTO "Service"
        ("vehicleId", "date", "odometer", "summary",
         "oil", "filterOil", "filterAir", "filterFuel", "filterCabin",
         "otherServices", "totalPrice",
         "createdAt", "updatedAt")
      VALUES (
        ${vehicleId},
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

    // recalcular lastService/nextReminder del vehículo
    await computeVehicleCategory(vehicleId)

    res.status(201).json(service)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al crear service' })
  }
})

// --------------------------------------------------
// MESSAGE TEMPLATE (PLANTILLAS DE MENSAJE)
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
