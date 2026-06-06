import { ReplayRow, StatsMessage } from '../types/contracts.js'

export class StatsAggregator {
  private totalFrames = 0
  private totalDetections = 0
  private lastEmitAt = 0
  private fpsWindow: number[] = []
  private readonly fpsWindowSize = 30

  reset(): void {
    this.totalFrames = 0
    this.totalDetections = 0
    this.lastEmitAt = 0
    this.fpsWindow = []
  }

  consume(row: ReplayRow, sessionId: string): StatsMessage {
    const now = Date.now()

    if (this.lastEmitAt > 0) {
      const intervalMs = now - this.lastEmitAt
      if (intervalMs > 0) {
        const instantFps = 1000 / intervalMs
        this.fpsWindow.push(instantFps)
        if (this.fpsWindow.length > this.fpsWindowSize) {
          this.fpsWindow.shift()
        }
      }
    }

    this.lastEmitAt = now
    this.totalFrames += 1
    this.totalDetections += row.detections

    const processingFps = this.fpsWindow.length
      ? this.fpsWindow.reduce((sum, value) => sum + value, 0) / this.fpsWindow.length
      : 0

    const avgObjectsPerFrame = this.totalFrames > 0
      ? this.totalDetections / this.totalFrames
      : 0

    const metadata = row.metadata ? JSON.stringify(row.metadata, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value
    ) : null;

    return {
      type: 'stats',
      sessionId,
      frameId: row.frameId,
      timestamp: new Date(row.timestampMs).toISOString(),
      processingFps,
      totalFrames: this.totalFrames,
      totalDetections: this.totalDetections,
      avgObjectsPerFrame,
      metadata: metadata ? JSON.parse(metadata) : null,
    }
  }
}
