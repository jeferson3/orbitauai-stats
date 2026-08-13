import {
  MetricValue,
  ReplayRow,
  TimelineEvent,
  TimelineResponse,
  TimelineStepSegment,
} from '../types/contracts.js'

/** Matches the Django fallback (`surgeon_progress.py` `DEFAULT_FPS`). */
const DEFAULT_FPS = 15

const SUMMARY_METRIC_PREFIX = 'summary.'
const SURGICAL_STEP_METRIC = 'surgical_step'
const PROCESSING_FPS_SUMMARY_KEY = `${SUMMARY_METRIC_PREFIX}processing_fps`

const toFiniteNumber = (value: MetricValue): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

const resolveFps = (summary: Record<string, MetricValue>): number => {
  const fromSummary = toFiniteNumber(summary[PROCESSING_FPS_SUMMARY_KEY] ?? null)
  return fromSummary && fromSummary > 0 ? fromSummary : DEFAULT_FPS
}

/**
 * Builds contiguous step segments from ordered `surgical_step` events,
 * mirroring `orbitau_local_app/src/metrics/metrics.py::_build_surgical_progress`
 * but covering the whole video (the first segment always starts at frame 0)
 * instead of only the frames seen so far during a live session.
 */
const buildStepSegments = (
  stepEvents: TimelineEvent[],
  totalFrames: number,
): TimelineStepSegment[] => {
  if (!stepEvents.length) {
    return []
  }

  const segments: TimelineStepSegment[] = []
  let currentStep = String(stepEvents[0].value)
  let startFrame = 0

  for (const event of stepEvents) {
    const step = String(event.value)
    if (step === currentStep) {
      continue
    }

    segments.push({
      step: currentStep,
      startFrame,
      endFrame: Math.max(startFrame, event.frameId - 1),
      isLazy: currentStep === 'Lazy',
    })
    currentStep = step
    startFrame = event.frameId
  }

  segments.push({
    step: currentStep,
    startFrame,
    endFrame: Math.max(startFrame, totalFrames),
    isLazy: currentStep === 'Lazy',
  })

  return segments
}

export function buildTimeline(rows: ReplayRow[]): TimelineResponse {
  const events: TimelineEvent[] = []
  const stepEvents: TimelineEvent[] = []
  const summary: Record<string, MetricValue> = {}
  let totalFrames = 0

  for (const row of rows) {
    totalFrames = Math.max(totalFrames, row.frameId)

    for (const metric of row.metrics) {
      if (metric.metricName.startsWith(SUMMARY_METRIC_PREFIX)) {
        summary[metric.metricName] = metric.metricValue
        continue
      }

      const event: TimelineEvent = {
        frameId: row.frameId,
        metricName: metric.metricName,
        value: metric.metricValue,
      }
      events.push(event)

      if (metric.metricName === SURGICAL_STEP_METRIC) {
        stepEvents.push(event)
      }
    }
  }

  return {
    fps: resolveFps(summary),
    totalFrames,
    events,
    summary,
    stepSegments: buildStepSegments(stepEvents, totalFrames),
  }
}

type CacheEntry = {
  response: TimelineResponse
  cachedAt: number
}

const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX_ENTRIES = 20
const cache = new Map<string, CacheEntry>()

const pruneCache = (): void => {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (now - entry.cachedAt > CACHE_TTL_MS) {
      cache.delete(key)
    }
  }

  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    cache.delete(oldestKey)
  }
}

/** Parquet files are immutable once written, so the built timeline is cached by URL. */
export function getCachedTimeline(parquetUrl: string): TimelineResponse | null {
  pruneCache()
  const entry = cache.get(parquetUrl)
  return entry ? entry.response : null
}

export function setCachedTimeline(parquetUrl: string, response: TimelineResponse): void {
  cache.set(parquetUrl, { response, cachedAt: Date.now() })
  pruneCache()
}
