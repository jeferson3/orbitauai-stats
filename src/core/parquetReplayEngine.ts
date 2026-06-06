import { ReplayRow, SyncMode } from '../types/contracts.js'

type ReplayCallbacks = {
  onFrame: (row: ReplayRow) => void
  onDone: () => void
  onError: (error: unknown) => void
}

type ReplayOptions = {
  syncMode: SyncMode
  fpsForFrameMode?: number
}

export class ParquetReplayEngine {
  private rows: ReplayRow[] = []
  private syncMode: SyncMode = 'timestamp'
  private currentIndex = 0
  private timer: NodeJS.Timeout | null = null
  private state: 'idle' | 'running' | 'paused' | 'stopped' = 'idle'
  private t0Wall = 0
  private t0Parquet = 0
  private pausedAt = 0
  private totalPausedMs = 0
  private fpsForFrameMode = 30
  private callbacks: ReplayCallbacks | null = null

  start(rows: ReplayRow[], options: ReplayOptions, callbacks: ReplayCallbacks): void {
    this.stop()

    this.rows = rows
    this.syncMode = options.syncMode
    this.fpsForFrameMode = options.fpsForFrameMode ?? 30
    this.currentIndex = 0
    this.totalPausedMs = 0
    this.pausedAt = 0
    this.t0Wall = Date.now()
    this.t0Parquet = rows[0]?.timestampMs ?? 0
    this.callbacks = callbacks
    this.state = 'running'

    this.scheduleNextTick()
  }

  pause(): void {
    if (this.state !== 'running') {
      return
    }

    this.state = 'paused'
    this.pausedAt = Date.now()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  resume(): void {
    if (this.state !== 'paused') {
      return
    }

    this.totalPausedMs += Date.now() - this.pausedAt
    this.pausedAt = 0
    this.state = 'running'
    this.scheduleNextTick()
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.state = 'stopped'
  }

  getState(): 'idle' | 'running' | 'paused' | 'stopped' {
    return this.state
  }

  private getRowDeltaMs(row: ReplayRow): number {
    if (this.syncMode === 'frame_id') {
      return (row.frameId / this.fpsForFrameMode) * 1000
    }

    return row.timestampMs - this.t0Parquet
  }

  private scheduleNextTick(): void {
    if (this.state !== 'running') {
      return
    }

    this.timer = setTimeout(() => {
      try {
        this.tick()
      } catch (error) {
        this.callbacks?.onError(error)
      }
    }, 16)
  }

  private tick(): void {
    if (this.state !== 'running') {
      return
    }

    while (this.currentIndex < this.rows.length) {
      const row = this.rows[this.currentIndex]
      const elapsedMs = Date.now() - this.t0Wall - this.totalPausedMs
      const rowDeltaMs = this.getRowDeltaMs(row)

      if (elapsedMs < rowDeltaMs) {
        break
      }

      this.callbacks?.onFrame(row)
      this.currentIndex += 1
    }

    if (this.currentIndex >= this.rows.length) {
      this.state = 'stopped'
      this.callbacks?.onDone()
      return
    }

    this.scheduleNextTick()
  }
}
