import path from 'node:path'
import { MetricValue, ReplayMetric, ReplayRow } from '../types/contracts.js'

type AsyncBuffer = {
  byteLength: number
  slice: (start: number, end?: number) => ArrayBuffer | Promise<ArrayBuffer>
}

type HyparquetSchemaNode = {
  element?: {
    name?: string
  }
  children?: HyparquetSchemaNode[]
}

type HyparquetModule = {
  asyncBufferFromFile: (filePath: string) => Promise<AsyncBuffer>
  parquetMetadataAsync: (file: AsyncBuffer) => Promise<unknown>
  parquetReadObjects: (options: {
    file: AsyncBuffer
    columns?: string[]
    compressors?: unknown
  }) => Promise<Record<string, unknown>[]>
  parquetSchema: (metadata: unknown) => HyparquetSchemaNode
}

const toTimestampMs = (value: unknown): number | null => {
  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isFinite(asNumber) ? asNumber : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (value instanceof Date) {
    return value.getTime()
  }

  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) {
      return asNumber
    }

    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return null
}

const toFrameId = (value: unknown): number | null => {
  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isFinite(asNumber) ? Math.trunc(asNumber) : null
  }

  if (typeof value === 'string') {
    const asNumber = Number(value)
    return Number.isFinite(asNumber) ? Math.trunc(asNumber) : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }

  return null
}

const toMetricValue = (value: unknown): MetricValue => {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isFinite(asNumber) ? asNumber : value.toString()
  }

  if (
    typeof value === 'number'
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  return String(value)
}

const getColumnNameMap = (schema: HyparquetSchemaNode): Map<string, string> => {
  return new Map(
    (schema.children ?? [])
      .map((node) => node.element?.name)
      .filter((value): value is string => Boolean(value))
      .map((value) => [value.toLowerCase(), value]),
  )
}

const SURGICAL_STEP_METRIC = 'surgical_step'

// Mapeamento oficial do orbitau_local_app (branch modal): metrics.py _get_step_value
const SURGICAL_STEP_CODE_LABELS: Record<number, string> = {
  0: 'Waiting',
  1: 'Incision',
  2: 'Capsulorrhexis',
  3: 'Phacoemulsification',
  4: 'IOL',
  5: 'Finished',
  6: 'Lazy',
}

const roundToOneDecimal = (value: number): number => Math.round(value * 10) / 10

const parseStepName = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as { step_name?: unknown }
    const name = parsed?.step_name
    return typeof name === 'string' && name.trim() ? name : null
  } catch {
    return null
  }
}

const formatMetricValue = (
  metricName: string,
  value: MetricValue,
  stepName: string | null,
): MetricValue => {
  if (metricName === SURGICAL_STEP_METRIC) {
    if (stepName) {
      return stepName
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return SURGICAL_STEP_CODE_LABELS[Math.round(value)] ?? String(value)
    }

    return value
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return roundToOneDecimal(value)
  }

  return value
}

const PARQUET_MAGIC = 'PAR1'
const PARQUET_FETCH_TIMEOUT_MS = Number(process.env.PARQUET_FETCH_TIMEOUT_MS ?? 30_000)
const PARQUET_S3_REGION = process.env.PARQUET_S3_REGION
  ?? process.env.AWS_REGION
  ?? process.env.AWS_DEFAULT_REGION
  ?? 'us-east-1'
const PARQUET_S3_BUCKETS = (process.env.PARQUET_S3_BUCKETS
  ?? process.env.PARQUET_S3_BUCKET
  ?? 'orbitau-prod-videos')
  .split(',')
  .map((bucket) => bucket.trim())
  .filter(Boolean)

type S3ObjectLocation = {
  bucket: string
  key: string
}

const parseS3ObjectFromUrl = (url: string): S3ObjectLocation | null => {
  try {
    const parsed = new URL(url)
    const virtualHostedMatch = parsed.hostname.match(
      /^(.+)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i,
    )

    if (virtualHostedMatch?.[1]) {
      const key = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
      return key ? { bucket: virtualHostedMatch[1], key } : null
    }

    if (
      parsed.hostname === 's3.amazonaws.com'
      || /^s3[.-][a-z0-9-]+\.amazonaws\.com$/i.test(parsed.hostname)
    ) {
      const [bucket, ...rest] = parsed.pathname.replace(/^\//, '').split('/')
      if (!bucket || rest.length === 0) {
        return null
      }

      return {
        bucket,
        key: decodeURIComponent(rest.join('/')),
      }
    }

    return null
  } catch {
    return null
  }
}

const shouldUseS3Client = (bucket: string): boolean => {
  if (process.env.PARQUET_FETCH_MODE === 'http') {
    return false
  }

  return PARQUET_S3_BUCKETS.includes(bucket)
}

const assertParquetBuffer = (buffer: ArrayBuffer): ArrayBuffer => {
  const bytes = new Uint8Array(buffer)

  if (
    bytes.length < PARQUET_MAGIC.length * 2
    || !hasParquetMagic(bytes, 0)
    || !hasParquetMagic(bytes, bytes.length - PARQUET_MAGIC.length)
  ) {
    throw new Error('parquet file invalid (footer != PAR1)')
  }

  return buffer
}

const formatS3FetchError = (
  location: S3ObjectLocation,
  error: unknown,
): Error => {
  const target = `s3://${location.bucket}/${location.key}`
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`Falha ao baixar parquet do S3 (${target}): ${message}`)
}

const loadS3ParquetBuffer = async (
  location: S3ObjectLocation,
): Promise<ArrayBuffer> => {
  const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3')
  const client = new S3Client({ region: PARQUET_S3_REGION })
  const response = await client.send(new GetObjectCommand({
    Bucket: location.bucket,
    Key: location.key,
  }))
  const body = await response.Body?.transformToByteArray()

  if (!body?.length) {
    throw new Error('Objeto parquet vazio no S3')
  }

  return new Uint8Array(body).buffer
}

const sanitizeUrlForError = (url: string): string => {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return '[invalid-url]'
  }
}

const formatFetchError = (url: string, error: unknown): Error => {
  const target = sanitizeUrlForError(url)

  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return new Error(`Falha ao baixar parquet remoto: timeout ao acessar ${target}`)
    }

    const cause = error.cause
    if (cause instanceof Error) {
      return new Error(`Falha ao baixar parquet remoto (${target}): ${cause.message}`)
    }

    return new Error(`Falha ao baixar parquet remoto (${target}): ${error.message}`)
  }

  return new Error(`Falha ao baixar parquet remoto (${target})`)
}

const hasParquetMagic = (bytes: Uint8Array, start: number): boolean => {
  if (start < 0 || start + PARQUET_MAGIC.length > bytes.length) {
    return false
  }

  return PARQUET_MAGIC
    .split('')
    .every((char, index) => bytes[start + index] === char.charCodeAt(0))
}

const loadRemoteParquetBuffer = async (url: string): Promise<ArrayBuffer> => {
  const s3Object = parseS3ObjectFromUrl(url)

  if (s3Object && shouldUseS3Client(s3Object.bucket)) {
    try {
      return assertParquetBuffer(await loadS3ParquetBuffer(s3Object))
    } catch (error) {
      if (process.env.PARQUET_FETCH_MODE === 's3') {
        throw formatS3FetchError(s3Object, error)
      }
    }
  }

  let response: Response

  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(PARQUET_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw formatFetchError(url, error)
  }

  if (!response.ok) {
    if (response.status === 403 && s3Object && shouldUseS3Client(s3Object.bucket)) {
      try {
        return assertParquetBuffer(await loadS3ParquetBuffer(s3Object))
      } catch (s3Error) {
        throw formatS3FetchError(s3Object, s3Error)
      }
    }

    throw new Error(
      `Falha ao baixar parquet remoto: HTTP ${response.status} (${sanitizeUrlForError(url)})`,
    )
  }

  return assertParquetBuffer(await response.arrayBuffer())
}

export async function loadReplayRows(parquetUrl: string): Promise<ReplayRow[]> {
  const hyparquetModule = await import('hyparquet') as unknown as HyparquetModule
  const { compressors } = await import('hyparquet-compressors')

  const source = /^https?:\/\//i.test(parquetUrl)
    ? parquetUrl
    : path.resolve(parquetUrl)

  const file = /^https?:\/\//i.test(parquetUrl)
    ? await loadRemoteParquetBuffer(source)
    : await hyparquetModule.asyncBufferFromFile(source)

  const metadata = await hyparquetModule.parquetMetadataAsync(file)
  const schema = hyparquetModule.parquetSchema(metadata)
  const availableColumns = getColumnNameMap(schema)

  const frameColumnCandidates = ['frame_id', 'frameid', 'frameno']
  const timestampColumnCandidates = ['timestamp_ms', 'timestamp']
  const metricNameColumnCandidates = ['metric_name', 'metricname', 'metric']
  const metricValueColumnCandidates = ['metric_value', 'metricvalue', 'value']
  const metricMetaColumnCandidates = ['metadata', 'meta']

  const selectedFrameColumn = frameColumnCandidates
    .map((column) => availableColumns.get(column))
    .find((column): column is string => Boolean(column))

  const selectedTimestampColumn = timestampColumnCandidates
    .map((column) => availableColumns.get(column))
    .find((column): column is string => Boolean(column))

  if (!selectedFrameColumn || !selectedTimestampColumn) {
    throw new Error('Parquet inválido: colunas de frame/timestamp não encontradas')
  }

  const selectedMetricNameColumn = metricNameColumnCandidates
    .map((column) => availableColumns.get(column))
    .find((column): column is string => Boolean(column))

  const selectedMetricValueColumn = metricValueColumnCandidates
    .map((column) => availableColumns.get(column))
    .find((column): column is string => Boolean(column))

  const selectedMetricMetaColumn = metricMetaColumnCandidates
    .map((column) => availableColumns.get(column))
    .find((column): column is string => Boolean(column))

  const hasMetricColumns = Boolean(selectedMetricNameColumn && selectedMetricValueColumn)

  const columnsToRead = [selectedFrameColumn, selectedTimestampColumn]
  if (selectedMetricNameColumn) {
    columnsToRead.push(selectedMetricNameColumn)
  }
  if (selectedMetricValueColumn) {
    columnsToRead.push(selectedMetricValueColumn)
  }
  if (selectedMetricMetaColumn) {
    columnsToRead.push(selectedMetricMetaColumn)
  }

  const rows = await hyparquetModule.parquetReadObjects({
    file,
    columns: columnsToRead,
    compressors,
  })

  const grouped = new Map<string, ReplayRow>()

  for (const row of rows) {
    const frameId = toFrameId(row[selectedFrameColumn])
    const timestampMs = toTimestampMs(row[selectedTimestampColumn])

    if (frameId === null || timestampMs === null) {
      continue
    }

    let metric: ReplayMetric | null = null
    if (hasMetricColumns && selectedMetricNameColumn && selectedMetricValueColumn) {
      const rawName = row[selectedMetricNameColumn]
      if (typeof rawName === 'string' && rawName.trim()) {
        const stepName = selectedMetricMetaColumn
          ? parseStepName(row[selectedMetricMetaColumn])
          : null

        metric = {
          metricName: rawName,
          metricValue: formatMetricValue(
            rawName,
            toMetricValue(row[selectedMetricValueColumn]),
            stepName,
          ),
        }
      }
    }

    const key = `${timestampMs}:${frameId}`
    const current = grouped.get(key)

    if (current) {
      current.detections += 1
      if (metric) {
        current.metrics.push(metric)
      }
      continue
    }

    grouped.set(key, {
      frameId,
      timestampMs,
      detections: 1,
      metrics: metric ? [metric] : [],
    })
  }

  return [...grouped.values()].sort((left, right) => {
    if (left.timestampMs !== right.timestampMs) {
      return left.timestampMs - right.timestampMs
    }

    return left.frameId - right.frameId
  })
}
