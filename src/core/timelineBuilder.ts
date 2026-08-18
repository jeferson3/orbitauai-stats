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
const ASSISTANT_ODOMETER_METRIC = 'assistant_odometer_cd'
const HAND_MOVEMENT_SUMMARY_KEY = `${SUMMARY_METRIC_PREFIX}hand_movement`
const HAND_MOVEMENT_UNIT_SUMMARY_KEY = `${SUMMARY_METRIC_PREFIX}hand_movement_unit`
const PROCESSING_FPS_SUMMARY_KEY = `${SUMMARY_METRIC_PREFIX}processing_fps`

/** Active surgical phases — mirrors `session_summary.ACTIVE_STEP_VALUES`. */
const ACTIVE_SURGICAL_STEPS = new Set([
  'Incision',
  'Capsulorrhexis',
  'Phacoemulsification',
  'IOL',
])

const roundToOneDecimal = (value: number): number => Math.round(value * 10) / 10

const parseSummaryMetadataUnit = (raw: string | null | undefined): string | null => {
  if (!raw?.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as { unit?: unknown }
    return typeof parsed.unit === 'string' && parsed.unit.trim()
      ? parsed.unit.trim()
      : null
  } catch {
    return null
  }
}

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

const stepAtFrame = (
  stepEvents: TimelineEvent[],
  frameId: number,
): string | null => {
  let step: string | null = null
  for (const event of stepEvents) {
    if (event.frameId <= frameId) {
      step = String(event.value)
      continue
    }
    break
  }
  return step
}

/**
 * When frame-level `assistant_odometer_cd` exists, derive Hand Stability from
 * its session max during active phases (same rule as `session_summary.py`).
 * Also forwards `metadata.unit` from the parquet summary row, which the raw
 * parquet loader previously dropped before it reached the frontend report.
 */
const reconcileHandMovement = (
  summary: Record<string, MetricValue>,
  events: TimelineEvent[],
  stepEvents: TimelineEvent[],
  handMovementMetadataUnit: string | null,
): void => {
  if (handMovementMetadataUnit && !summary[HAND_MOVEMENT_UNIT_SUMMARY_KEY]) {
    summary[HAND_MOVEMENT_UNIT_SUMMARY_KEY] = handMovementMetadataUnit
  }

  const odometerEvents = events.filter(
    (event) => event.metricName === ASSISTANT_ODOMETER_METRIC,
  )
  if (!odometerEvents.length) {
    return
  }

  let maxCd = 0
  for (const event of odometerEvents) {
    const value = toFiniteNumber(event.value)
    if (value === null) {
      continue
    }

    const step = stepAtFrame(stepEvents, event.frameId)
    if (step && !ACTIVE_SURGICAL_STEPS.has(step)) {
      continue
    }

    if (value > maxCd) {
      maxCd = value
    }
  }

  if (maxCd <= 0) {
    for (const event of odometerEvents) {
      const value = toFiniteNumber(event.value)
      if (value !== null && value > maxCd) {
        maxCd = value
      }
    }
  }

  if (maxCd > 0) {
    summary[HAND_MOVEMENT_SUMMARY_KEY] = roundToOneDecimal(maxCd)
    summary[HAND_MOVEMENT_UNIT_SUMMARY_KEY] = 'cd'
  }
}

export function buildTimeline(rows: ReplayRow[]): TimelineResponse {
  const events: TimelineEvent[] = []
  const stepEvents: TimelineEvent[] = []
  const summary: Record<string, MetricValue> = {}
  let handMovementMetadataUnit: string | null = null
  let totalFrames = 0

  for (const row of rows) {
    totalFrames = Math.max(totalFrames, row.frameId)

    for (const metric of row.metrics) {
      if (metric.metricName.startsWith(SUMMARY_METRIC_PREFIX)) {
        summary[metric.metricName] = metric.metricValue
        if (metric.metricName === HAND_MOVEMENT_SUMMARY_KEY) {
          handMovementMetadataUnit = parseSummaryMetadataUnit(metric.metadataRaw)
        }
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

  reconcileHandMovement(summary, events, stepEvents, handMovementMetadataUnit)

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
