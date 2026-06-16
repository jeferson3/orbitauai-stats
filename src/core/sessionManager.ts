import { loadReplayRows } from '../data/parquetLoader.js'
import {
  SessionCurrentResponse,
  SessionState,
  StartSessionRequest,
  StatsMessage,
  StatusMessage,
} from '../types/contracts.js'
import { ParquetReplayEngine } from './parquetReplayEngine.js'
import { StatsAggregator } from './statsAggregator.js'

type SessionCallbacks = {
  onStatus: (payload: StatusMessage) => void
  onStats: (payload: StatsMessage) => void
}

type SessionData = {
  sessionId: string
  startedAt: string
  videoUrl: string
  parquetUrl: string
  syncMode: 'timestamp' | 'frame_id'
  targetBroadcastMs: number
}

export class SessionManager {
  private state: SessionState = 'idle'
  private sessionData: SessionData | null = null
  private engine = new ParquetReplayEngine()
  private aggregator = new StatsAggregator()
  private callbacks: SessionCallbacks
  private lastStatsAt = 0

  constructor(callbacks: SessionCallbacks) {
    this.callbacks = callbacks
  }

  getCurrent(): SessionCurrentResponse {
    return {
      state: this.state,
      sessionId: this.sessionData?.sessionId ?? null,
      startedAt: this.sessionData?.startedAt ?? null,
      videoUrl: this.sessionData?.videoUrl ?? null,
      parquetUrl: this.sessionData?.parquetUrl ?? null,
      syncMode: this.sessionData?.syncMode ?? null,
      targetBroadcastMs: this.sessionData?.targetBroadcastMs ?? null,
    }
  }

  async start(payload: StartSessionRequest): Promise<SessionCurrentResponse> {
    this.assertState(['idle', 'stopped', 'error'], 'Start permitido apenas em idle/stopped/error')

    const rows = await loadReplayRows(payload.parquetUrl)
    if (!rows.length) {
      this.setState('error', 'Parquet sem dados válidos para replay')
      throw new Error('Parquet sem dados válidos para replay')
    }

    this.aggregator.reset()
    this.lastStatsAt = 0

    const sessionId = this.generateSessionId()
    const targetBroadcastMs = payload.targetBroadcastMs ?? 500
    this.sessionData = {
      sessionId,
      startedAt: new Date().toISOString(),
      videoUrl: payload.videoUrl,
      parquetUrl: payload.parquetUrl,
      syncMode: payload.syncMode ?? 'timestamp',
      targetBroadcastMs,
    }

    this.engine.start(
      rows,
      {
        syncMode: this.sessionData.syncMode,
      },
      {
        onFrame: (row) => {
          if (!this.sessionData) {
            return
          }

          const snapshot = this.aggregator.consume(row, this.sessionData.sessionId)
          const now = Date.now()

          if (
            this.lastStatsAt === 0
            || now - this.lastStatsAt >= this.sessionData.targetBroadcastMs
          ) {
            this.lastStatsAt = now

            if (row.metrics.length === 0) {
              this.callbacks.onStats(snapshot)
              return
            }

            for (const metric of row.metrics) {
              this.callbacks.onStats({
                ...snapshot,
                metadata: {
                  metric_name: metric.metricName,
                  metric_value: metric.metricValue,
                },
              })
            }
          }
        },
        onDone: () => {
          this.setState('stopped')
        },
        onError: (error) => {
          const message = error instanceof Error ? error.message : 'Erro no replay'
          this.setState('error', message)
        },
      },
    )

    this.setState('running')
    return this.getCurrent()
  }

  pause(): SessionCurrentResponse {
    this.assertState(['running'], 'Pause permitido apenas em running')
    this.engine.pause()
    this.setState('paused')
    return this.getCurrent()
  }

  resume(): SessionCurrentResponse {
    this.assertState(['paused'], 'Resume permitido apenas em paused')
    this.engine.resume()
    this.setState('running')
    return this.getCurrent()
  }

  stop(): SessionCurrentResponse {
    this.assertState(['running', 'paused'], 'Stop permitido apenas em running/paused')
    this.engine.stop()
    this.setState('stopped')
    return this.getCurrent()
  }

  private assertState(validStates: SessionState[], message: string): void {
    if (!validStates.includes(this.state)) {
      throw new Error(message)
    }
  }

  private setState(state: SessionState, message?: string): void {
    this.state = state
    this.callbacks.onStatus({
      type: 'status',
      state,
      message,
    })
  }

  private generateSessionId(): string {
    const now = new Date()
    const date = `${now.getFullYear()}${`${now.getMonth() + 1}`.padStart(2, '0')}${`${now.getDate()}`.padStart(2, '0')}`
    const time = `${`${now.getHours()}`.padStart(2, '0')}${`${now.getMinutes()}`.padStart(2, '0')}${`${now.getSeconds()}`.padStart(2, '0')}`
    return `${date}_${time}`
  }
}
