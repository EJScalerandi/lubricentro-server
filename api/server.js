import express from 'express'
const app = express()
app.get('/health', (req,res)=>res.json({ok:true}))
export default app
