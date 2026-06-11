import { type Express, type Request, type Response } from 'express'
import { z } from 'zod'
import { SessionManager } from '../core/sessionManager.js'
import { logRequestError } from '../utils/errorLogger.js'

const StartSchema = z.object({
  videoUrl: z.string().min(1),
  parquetUrl: z.string().min(1),
  syncMode: z.enum(['timestamp', 'frame_id']).optional(),
  targetBroadcastMs: z.number().int().positive().max(5000).optional(),
})

const handleRouteError = async (
  request: Request,
  response: Response,
  error: unknown,
  fallbackMessage: string,
): Promise<Response> => {
  const statusCode = 400
  const message = error instanceof Error ? error.message : fallbackMessage

  await logRequestError({ request, statusCode, error })

  return response.status(statusCode).json({ message })
}

export async function registerSessionRoutes(
  app: Express,
  sessionManager: SessionManager,
): Promise<void> {
  app.post('/api/session/start', async (request: Request, response: Response) => {
    try {
      const payload = StartSchema.parse(request.body)
      const current = await sessionManager.start(payload)
      return response.status(200).json(current)
    } catch (error) {
      return handleRouteError(request, response, error, 'Erro ao iniciar sessão')
    }
  })

  app.post('/api/session/pause', async (request: Request, response: Response) => {
    try {
      const current = sessionManager.pause()
      return response.status(200).json(current)
    } catch (error) {
      return handleRouteError(request, response, error, 'Erro ao pausar sessão')
    }
  })

  app.post('/api/session/resume', async (request: Request, response: Response) => {
    try {
      const current = sessionManager.resume()
      return response.status(200).json(current)
    } catch (error) {
      return handleRouteError(request, response, error, 'Erro ao retomar sessão')
    }
  })

  app.post('/api/session/stop', async (request: Request, response: Response) => {
    try {
      const current = sessionManager.stop()
      return response.status(200).json(current)
    } catch (error) {
      return handleRouteError(request, response, error, 'Erro ao encerrar sessão')
    }
  })

  app.get('/api/session/current', async (request: Request, response: Response) => {
    try {
      return response.status(200).json(sessionManager.getCurrent())
    } catch (error) {
      return handleRouteError(request, response, error, 'Erro ao consultar sessão')
    }
  })
}
