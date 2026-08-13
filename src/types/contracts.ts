export type SessionState = 'idle' | 'running' | 'paused' | 'stopped' | 'error'

export type SyncMode = 'timestamp' | 'frame_id'

export type MetricValue = number | string | boolean | null

export type StatsMetadata = {
  metric_name: string
  metric_value: MetricValue
}

export type StatsMessage = {
  type: 'stats'
  sessionId: string
  frameId: number
  timestamp: string
  processingFps: number
  totalFrames: number
  totalDetections: number
  avgObjectsPerFrame: number
  metadata: StatsMetadata | null
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

export type ReplayMetric = {
  metricName: string
  metricValue: MetricValue
}

export type ReplayRow = {
  frameId: number
  timestampMs: number
  detections: number
  metrics: ReplayMetric[]
}

/** A single non-summary metric reading, flattened across the whole parquet. */
export type TimelineEvent = {
  frameId: number
  metricName: string
  value: MetricValue
}

/** Contiguous run of frames sharing the same `surgical_step` reading. */
export type TimelineStepSegment = {
  step: string
  startFrame: number
  endFrame: number
  isLazy: boolean
}

/**
 * Full-video replacement for the WebSocket replay: everything the frontend
 * needs is fetched once and frames are derived locally from
 * `video.currentTime * fps`, instead of a wall-clock-driven, forward-only
 * stream. See `timelineBuilder.ts`.
 */
export type TimelineResponse = {
  fps: number
  totalFrames: number
  events: TimelineEvent[]
  summary: Record<string, MetricValue>
  stepSegments: TimelineStepSegment[]
}
