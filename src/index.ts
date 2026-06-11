import { createServer } from 'node:http'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { SessionManager } from './core/sessionManager.js'
import { registerSessionRoutes } from './routes/sessionRoutes.js'
import {
  logHttpError,
  logSecurityProbeIfDetected,
} from './utils/errorLogger.js'
import { StatsHub } from './ws/statsHub.js'

const port = Number(process.env.PORT ?? process.env.STATS_PORT ?? 80)
const host = process.env.STATS_HOST ?? '0.0.0.0'

const app = express()
const statsHub = new StatsHub()

app.set('trust proxy', 1)

const sessionManager = new SessionManager({
  onStatus: (payload) => {
    statsHub.broadcast(payload)
  },
  onStats: (payload) => {
    statsHub.broadcast(payload)
  },
})

app.use(async (request: Request, response: Response, next: NextFunction) => {
  if (await logSecurityProbeIfDetected(request)) {
    response.status(404).json({
      ok: false,
      message: 'Route not found',
    })
    return
  }

  next()
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

app.use(async (request: Request, response: Response) => {
  const statusCode = 404
  const error = new Error('Route not found')

  await logHttpError({ request, statusCode, error })

  response.status(404).json({
    ok: false,
    message: error.message,
    path: request.url,
  })
})

app.use(async (
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
) => {
  const errorStatus = typeof error === 'object'
    && error !== null
    && 'status' in error
    && typeof error.status === 'number'
    ? error.status
    : 500
  const statusCode = errorStatus >= 400 && errorStatus < 600 ? errorStatus : 500
  const message = error instanceof Error ? error.message : 'Internal server error'

  await logHttpError({ request, statusCode, error })

  response.status(statusCode).json({
    ok: false,
    message,
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
