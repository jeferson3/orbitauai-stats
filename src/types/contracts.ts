export type SessionState = 'idle' | 'running' | 'paused' | 'stopped' | 'error'

export type SyncMode = 'timestamp' | 'frame_id'

export type StatsMessage = {
  type: 'stats'
  sessionId: string
  frameId: number
  timestamp: string
  processingFps: number
  totalFrames: number
  totalDetections: number
  avgObjectsPerFrame: number
  metadata: Record<string, unknown>
}

export type StatusMessage = {
  type: 'status'
  state: SessionState
  message?: string
}

export type WsServerMessage = StatsMessage | StatusMessage

export type StartSessionRequest = {
  videoUrl: string
  parquetUrl: string
  syncMode?: SyncMode
  targetBroadcastMs?: number
}

export type SessionCurrentResponse = {
  state: SessionState
  sessionId: string | null
  startedAt: string | null
  videoUrl: string | null
  parquetUrl: string | null
  syncMode: SyncMode | null
  targetBroadcastMs: number | null
}

export type ReplayRow = {
  frameId: number
  timestampMs: number
  detections: number
  metadata: Record<string, unknown>
}
