// prisma/seed.js
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000)

async function main() {
  // Categorías base (necesarias para nextReminder)
  const cats = await Promise.all([
    prisma.category.upsert({ where: { name: 'ALTA'  }, update: {}, create: { name: 'ALTA',  everyDays: 30,  description: 'Uso intenso' } }),
    prisma.category.upsert({ where: { name: 'MEDIA' }, update: {}, create: { name: 'MEDIA', everyDays: 90,  description: 'Uso normal' } }),
    prisma.category.upsert({ where: { name: 'BAJA'  }, update: {}, create: { name: 'BAJA',  everyDays: 180, description: 'Uso esporádico' } }),
  ])
  const catByName = Object.fromEntries(cats.map(c => [c.name, c]))

  // 5 clientes con 1 vehículo y 1 service reciente
  const today = new Date()
  const mock = [
    {
      client: { name: 'Juan Pérez', phone: '3511111111', birthday: new Date('1990-04-12'), notes: 'Prefiere WhatsApp' },
      vehicle:{ plate: 'AB123CD', brand: 'Fiat', model: 'Cronos', year: 2021, category: 'MEDIA' },
      service:{ date: addDays(today, -35), odometer: 45200, summary: 'Aceite 5W30 | Filtro aceite' }
    },
    {
      client: { name: 'María López', phone: '3512222222', birthday: new Date('1988-09-30'), notes: null },
      vehicle:{ plate: 'AC987BC', brand: 'Chevrolet', model: 'Onix', year: 2020, category: 'ALTA' },
      service:{ date: addDays(today, -20), odometer: 32000, summary: 'Aceite 5W30 | Filtro aire' }
    },
    {
      client: { name: 'Carlos Gómez', phone: '3513333333', birthday: new Date('1979-01-05'), notes: 'Cliente empresa' },
      vehicle:{ plate: 'AA555AA', brand: 'Toyota', model: 'Corolla', year: 2018, category: 'BAJA' },
      service:{ date: addDays(today, -120), odometer: 98500, summary: 'Aceite 0W20 | Filtro combustible' }
    },
    {
      client: { name: 'Lucía Fernández', phone: '3514444444', birthday: new Date('1995-07-22'), notes: null },
      vehicle:{ plate: 'AE321FG', brand: 'Volkswagen', model: 'Gol', year: 2015, category: 'MEDIA' },
      service:{ date: addDays(today, -70), odometer: 123400, summary: 'Aceite 10W40 | Filtro aceite + habitáculo' }
    },
    {
      client: { name: 'Diego Martínez', phone: '3515555555', birthday: new Date('1985-12-10'), notes: 'Viene de referencia' },
      vehicle:{ plate: 'AF777HJ', brand: 'Renault', model: 'Kangoo', year: 2019, category: 'ALTA' },
      service:{ date: addDays(today, -10), odometer: 67450, summary: 'Aceite 5W40 | Revisión general' }
    },
  ]

  for (const row of mock) {
    const c = await prisma.client.upsert({
      where: { phone: row.client.phone },
      update: {},
      create: row.client,
    })

    const v = await prisma.vehicle.upsert({
      where: { plate: row.vehicle.plate },
      update: {},
      create: {
        plate: row.vehicle.plate,
        clientId: c.id,
        brand: row.vehicle.brand,
        model: row.vehicle.model,
        year: row.vehicle.year,
        categoryId: catByName[row.vehicle.category].id,
      },
    })

    await prisma.service.create({
      data: {
        vehicleId: v.plate,
        clientId: c.id,
        date: row.service.date,
        odometer: row.service.odometer,
        summary: row.service.summary,
      }
    })

    // actualizar lastService/nextReminder según categoría
    const every = catByName[row.vehicle.category].everyDays
    await prisma.vehicle.update({
      where: { plate: v.plate },
      data: { lastService: row.service.date, nextReminder: addDays(row.service.date, every) }
    })
  }

  console.log('✅ Seed mock cargado')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
}).finally(async () => {
  await prisma.$disconnect()
})
