import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { type Request } from 'express'

type ErrorLogDetails = {
  request: Request
  statusCode: number
  error: unknown
}

type LogFileName = 'errors.log' | 'http-errors.log' | 'security-probes.log'

const logDirectory = path.resolve(process.env.LOG_DIR ?? 'logs')
const redactedValue = '[********]'
const allowedFilePaths = new Set([])
const sensitiveKeys = new Set([
  'authorization',
  'cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'x-api-key',
  'x-amz-credential',
  'x-amz-security-token',
  'x-amz-signature',
])

const normalizeKey = (key: string): string => key.trim().toLowerCase()

const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizeKey(key)
  return sensitiveKeys.has(normalized)
    || normalized.endsWith('_token')
    || normalized.endsWith('-token')
    || normalized.endsWith('_secret')
    || normalized.endsWith('-secret')
    || normalized.endsWith('_password')
    || normalized.endsWith('-password')
}

const sanitizeUrl = (value: string): string => {
  if (!value.includes('?')) {
    return value
  }

  try {
    const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    const url = new URL(value, 'http://logger.local')

    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, redactedValue)
      }
    }

    return isAbsolute
      ? url.toString()
      : `${url.pathname}${url.search}${url.hash}`
  } catch {
    return value
  }
}

const sanitizeValue = (
  value: unknown,
  seen = new WeakSet<object>(),
): unknown => {
  if (typeof value === 'string') {
    return sanitizeUrl(value)
  }

  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'undefined'
  ) {
    return value
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value !== 'object') {
    return String(value)
  }

  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen))
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? redactedValue : sanitizeValue(item, seen),
    ]),
  )
}

const serializeError = (
  error: unknown,
  seen = new WeakSet<object>(),
): Record<string, unknown> => {
  if (!(error instanceof Error)) {
    return {
      message: sanitizeValue(String(error)),
    }
  }

  if (seen.has(error)) {
    return { message: '[Circular error cause]' }
  }
  seen.add(error)

  const properties = Object.fromEntries(
    Object.getOwnPropertyNames(error)
      .filter((key) => !['name', 'message', 'stack', 'cause'].includes(key))
      .map((key) => [
        key,
        isSensitiveKey(key)
          ? redactedValue
          : sanitizeValue((error as unknown as Record<string, unknown>)[key]),
      ]),
  )

  return {
    name: error.name,
    message: sanitizeValue(error.message),
    stack: error.stack,
    ...properties,
    ...(error.cause === undefined
      ? {}
      : { cause: serializeError(error.cause, seen) }),
  }
}

const getExpectedHosts = (): Set<string> => {
  const configuredHosts = (process.env.APP_DOMAIN ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)

  return new Set(['localhost', '127.0.0.1', '::1', ...configuredHosts])
}

const isExpectedHost = (request: Request): boolean => {
  return getExpectedHosts().has(request.hostname.toLowerCase())
}

const isTryingToAccessFile = (request: Request): boolean => {
  const requestPath = request.path.toLowerCase()

  if (allowedFilePaths.has(requestPath)) {
    return false
  }

  const segments = requestPath.split('/').filter(Boolean)
  if (segments.some((segment) => segment.startsWith('.'))) {
    return true
  }

  const lastSegment = segments.at(-1)
  return Boolean(lastSegment && /\.[a-z0-9][a-z0-9_-]{0,15}$/i.test(lastSegment))
}

const getSecurityProbeReason = (request: Request): string | null => {
  if (!isExpectedHost(request)) {
    return 'invalid_host'
  }

  if (isTryingToAccessFile(request)) {
    return 'file_access'
  }

  return null
}

const buildEntry = ({
  request,
  statusCode,
  error,
}: ErrorLogDetails): Record<string, unknown> => {
  return {
    timestamp: new Date().toISOString(),
    statusCode,
    method: request.method,
    path: sanitizeUrl(request.originalUrl),
    host: request.hostname,
    ip: request.ip,
    userAgent: request.get('user-agent') ?? null,
    referer: sanitizeValue(request.get('referer') ?? null),
    query: sanitizeValue(request.query),
    body: sanitizeValue(request.body ?? null),
    error: serializeError(error),
  }
}

const writeLog = async (
  fileName: LogFileName,
  entry: Record<string, unknown>,
): Promise<void> => {
  try {
    await mkdir(logDirectory, { recursive: true })
    await appendFile(
      path.join(logDirectory, fileName),
      `${JSON.stringify(entry)}\n`,
      'utf8',
    )
  } catch (loggerError) {
    console.error('Failed to write request error log', loggerError, entry)
  }
}

export async function logRequestError(details: ErrorLogDetails): Promise<void> {
  await writeLog('errors.log', buildEntry(details))
}

export async function logHttpError(details: ErrorLogDetails): Promise<void> {
  const probeReason = getSecurityProbeReason(details.request)
  const entry = {
    ...(probeReason ? { reason: probeReason } : {}),
    ...buildEntry(details),
  }

  await writeLog(
    probeReason ? 'security-probes.log' : 'http-errors.log',
    entry,
  )
}

export async function logSecurityProbeIfDetected(
  request: Request,
  statusCode = 404,
): Promise<boolean> {
  const reason = getSecurityProbeReason(request)
  if (!reason) {
    return false
  }

  await writeLog('security-probes.log', {
    reason,
    ...buildEntry({
      request,
      statusCode,
      error: new Error('Blocked security probe'),
    }),
  })

  return true
}
