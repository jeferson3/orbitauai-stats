import path from 'node:path'
import { ReplayRow } from '../types/contracts.js'

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

const getColumnNameMap = (schema: HyparquetSchemaNode): Map<string, string> => {
  return new Map(
    (schema.children ?? [])
      .map((node) => node.element?.name)
      .filter((value): value is string => Boolean(value))
      .map((value) => [value.toLowerCase(), value]),
  )
}

const PARQUET_MAGIC = 'PAR1'

const hasParquetMagic = (bytes: Uint8Array, start: number): boolean => {
  if (start < 0 || start + PARQUET_MAGIC.length > bytes.length) {
    return false
  }

  return PARQUET_MAGIC
    .split('')
    .every((char, index) => bytes[start + index] === char.charCodeAt(0))
}

const loadRemoteParquetBuffer = async (url: string): Promise<ArrayBuffer> => {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Falha ao baixar parquet remoto: HTTP ${response.status}`)
  }

  const buffer = await response.arrayBuffer()
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

  const frameColumnCandidates = ['frame_id', 'frameid', 'frameno', 'metadata']
  const timestampColumnCandidates = ['timestamp_ms', 'timestamp', 'metadata']

  const selectedFrameColumn = frameColumnCandidates
    .map((column) => availableColumns.get(column))
    .find((column): column is string => Boolean(column))

  const selectedTimestampColumn = timestampColumnCandidates
    .map((column) => availableColumns.get(column))
    .find((column): column is string => Boolean(column))

  if (!selectedFrameColumn || !selectedTimestampColumn) {
    throw new Error('Parquet inválido: colunas de frame/timestamp não encontradas')
  }

  const rows = await hyparquetModule.parquetReadObjects({
    file,
    compressors,
  })

  const grouped = new Map<string, ReplayRow>()

  for (const row of rows) {
    const frameId = toFrameId(row[selectedFrameColumn])
    const timestampMs = toTimestampMs(row[selectedTimestampColumn])

    if (frameId === null || timestampMs === null) {
      continue
    }

    const key = `${timestampMs}:${frameId}`
    const current = grouped.get(key)

    if (current) {
      current.detections += 1
      continue
    }

    grouped.set(key, {
      frameId,
      metadata: row,
      timestampMs,
      detections: 1,
    })
  }

  return [...grouped.values()].sort((left, right) => {
    if (left.timestampMs !== right.timestampMs) {
      return left.timestampMs - right.timestampMs
    }

    return left.frameId - right.frameId
  })
}
