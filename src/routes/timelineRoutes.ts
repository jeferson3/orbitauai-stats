import { type Express, type Request, type Response } from 'express'
import { z } from 'zod'
import { buildTimeline, getCachedTimeline, setCachedTimeline } from '../core/timelineBuilder.js'
import { loadReplayRows } from '../data/parquetLoader.js'
import { logRequestError } from '../utils/errorLogger.js'

const TimelineQuerySchema = z.object({
  parquetUrl: z.string().min(1),
})

export function registerTimelineRoutes(app: Express): void {
  app.get('/api/timeline', async (request: Request, response: Response) => {
    try {
      const { parquetUrl } = TimelineQuerySchema.parse(request.query)

      const cached = getCachedTimeline(parquetUrl)
      if (cached) {
        return response.status(200).json(cached)
      }

      const rows = await loadReplayRows(parquetUrl)
      if (!rows.length) {
        return response.status(422).json({ message: 'Parquet sem dados válidos' })
      }

      const timeline = buildTimeline(rows)
      setCachedTimeline(parquetUrl, timeline)

      return response.status(200).json(timeline)
    } catch (error) {
      const statusCode = 400
      const message = error instanceof Error ? error.message : 'Erro ao montar timeline'

      await logRequestError({ request, statusCode, error })

      return response.status(statusCode).json({ message })
    }
  })
}
