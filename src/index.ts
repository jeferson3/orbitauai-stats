import { createServer } from 'node:http'
import cors from 'cors'
import express, { type Request, type Response } from 'express'
import { SessionManager } from './core/sessionManager.js'
import { registerSessionRoutes } from './routes/sessionRoutes.js'
import { StatsHub } from './ws/statsHub.js'

const port = Number(process.env.PORT ?? process.env.STATS_PORT ?? 8787)
const host = process.env.STATS_HOST ?? '0.0.0.0'

const app = express()
const statsHub = new StatsHub()

const sessionManager = new SessionManager({
  onStatus: (payload) => {
    statsHub.broadcast(payload)
  },
  onStats: (payload) => {
    statsHub.broadcast(payload)
  },
})

app.use(express.json())
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['content-type', 'authorization'],
}))

registerSessionRoutes(app, sessionManager)

app.get('/', (_request: Request, response: Response) => {
  response.status(200).json({
    ok: true,
    service: 'orbitau-stats-backend',
    health: '/health',
    currentSession: '/api/session/current',
    websocket: '/ws/stats',
  })
})

app.get('/health', (_request: Request, response: Response) => {
  response.status(200).json({ ok: true })
})

app.get('/api/health', (_request: Request, response: Response) => {
  response.status(200).json({ ok: true })
})

app.use((request: Request, response: Response) => {
  response.status(404).json({
    ok: false,
    message: 'Route not found',
    path: request.url,
  })
})

const server = createServer(app)

server.on('upgrade', (request, socket, head) => {
  if (request.url?.startsWith('/ws/stats')) {
    statsHub.handleUpgrade(request, socket, head)
    return
  }

  socket.destroy()
})

server.listen(port, host, () => {
  console.log(`Stats backend running on http://${host}:${port}`)
})

server.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
