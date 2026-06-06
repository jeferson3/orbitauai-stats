import { type Express, type Request, type Response } from 'express'
import { z } from 'zod'
import { SessionManager } from '../core/sessionManager.js'

const StartSchema = z.object({
  videoUrl: z.string().min(1),
  parquetUrl: z.string().min(1),
  syncMode: z.enum(['timestamp', 'frame_id']).optional(),
  targetBroadcastMs: z.number().int().positive().max(5000).optional(),
})

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
      const message = error instanceof Error ? error.message : 'Erro ao iniciar sessão'
      return response.status(400).json({ message })
    }
  })

  app.post('/api/session/pause', async (_request: Request, response: Response) => {
    try {
      const current = sessionManager.pause()
      return response.status(200).json(current)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao pausar sessão'
      return response.status(400).json({ message })
    }
  })

  app.post('/api/session/resume', async (_request: Request, response: Response) => {
    try {
      const current = sessionManager.resume()
      return response.status(200).json(current)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao retomar sessão'
      return response.status(400).json({ message })
    }
  })

  app.post('/api/session/stop', async (_request: Request, response: Response) => {
    try {
      const current = sessionManager.stop()
      return response.status(200).json(current)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao encerrar sessão'
      return response.status(400).json({ message })
    }
  })

  app.get('/api/session/current', async (_request: Request, response: Response) => {
    return response.status(200).json(sessionManager.getCurrent())
  })
}
