import { loadIceServiceOptions } from './ice.js'
import { createSignalingServer, type SignalingServer } from './server.js'
import { loadSecurityAuditWriter } from './securityAuditConfig.js'

let server: SignalingServer | undefined
let shutdownPromise: Promise<void> | undefined
let startupPromise: Promise<void> = Promise.resolve()
let auditWatchdog: NodeJS.Timeout | undefined
let fatalErrorHandled = false
let shutdownRequested = false
let requestedExitCode = 0

process.once('SIGINT', () => void shutdown(0))
process.once('SIGTERM', () => void shutdown(0))
process.on('uncaughtException', () => handleFatalError('unhandled_exception'))
process.on('unhandledRejection', () => handleFatalError('unhandled_rejection'))

startupPromise = main()
void startupPromise.catch(() => {
  handleFatalError('startup_failed')
})

async function main(): Promise<void> {
  const port = parseIntegerEnvironment('PORT', 8080, 0, 65_535)
  const configuredOrigins = process.env.SIGNALING_ALLOWED_ORIGINS
  const allowedOrigins = configuredOrigins
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  const trustCloudflareConnectingIp = parseBooleanEnvironment(
    'TRUST_CLOUDFLARE_CONNECTING_IP',
    false,
  )
  const maxConnections = parseIntegerEnvironment(
    'SIGNALING_MAX_CONNECTIONS',
    256,
    1,
    100_000,
  )
  const maxConnectionsPerIp = parseIntegerEnvironment(
    'SIGNALING_MAX_CONNECTIONS_PER_IP',
    16,
    1,
    maxConnections,
  )
  const maxSessions = parseIntegerEnvironment(
    'SIGNALING_MAX_SESSIONS',
    96,
    1,
    100_000,
  )
  const maxSessionsPerIp = parseIntegerEnvironment(
    'SIGNALING_MAX_SESSIONS_PER_IP',
    4,
    1,
    maxSessions,
  )
  const audit = await loadSecurityAuditWriter()
  if (shutdownRequested) {
    await audit?.close()
    return
  }

  server = createSignalingServer({
    port,
    ice: loadIceServiceOptions(),
    allowedOrigins,
    trustCloudflareConnectingIp,
    audit,
    security: {
      maxConnections,
      maxConnectionsPerIp,
      maxSessions,
      maxSessionsPerIp,
    },
  })
  const boundPort = await server.start()
  if (shutdownRequested) {
    await server.stop()
    return
  }
  if (audit) {
    auditWatchdog = setInterval(() => {
      if (shutdownRequested) return
      try {
        if (!audit.status.ok) handleFatalError('audit_unavailable')
      } catch {
        handleFatalError('audit_unavailable')
      }
    }, 1_000)
    auditWatchdog.unref()
  }
  process.stdout.write(
    `${JSON.stringify({ type: 'service.ready', port: boundPort })}\n`,
  )
}

async function shutdown(exitCode: number): Promise<void> {
  shutdownRequested = true
  requestedExitCode = Math.max(requestedExitCode, exitCode)
  process.exitCode = Math.max(currentExitCode(), requestedExitCode)
  if (auditWatchdog) {
    clearInterval(auditWatchdog)
    auditWatchdog = undefined
  }
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      try {
        try {
          await startupPromise
        } catch {
          // Başlangıç hatası üst katmanda yalnız sabit kodla raporlanır.
        }
        await server?.stop()
      } catch {
        writeSafeServiceError('shutdown_failed')
        requestedExitCode = 1
      } finally {
        process.exitCode = Math.max(currentExitCode(), requestedExitCode)
      }
    })()
  }
  await shutdownPromise
}

function handleFatalError(
  code:
    | 'startup_failed'
    | 'audit_unavailable'
    | 'unhandled_exception'
    | 'unhandled_rejection',
): void {
  if (fatalErrorHandled) return
  fatalErrorHandled = true
  requestedExitCode = 1
  process.exitCode = 1
  writeSafeServiceError(code)
  void shutdown(1)
}

function currentExitCode(): number {
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}

function writeSafeServiceError(
  code:
    | 'startup_failed'
    | 'audit_unavailable'
    | 'shutdown_failed'
    | 'unhandled_exception'
    | 'unhandled_rejection',
): void {
  process.stderr.write(`${JSON.stringify({ type: 'service.error', code })}\n`)
}

function parseBooleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('Geçersiz boolean ortam değişkeni.')
}

function parseIntegerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) {
    throw new Error('Geçersiz tam sayı ortam değişkeni.')
  }
  const parsed = Number.parseInt(value, 10)
  if (parsed < minimum || parsed > maximum) {
    throw new Error('Ortam değişkeni güvenli aralığın dışında.')
  }
  return parsed
}
