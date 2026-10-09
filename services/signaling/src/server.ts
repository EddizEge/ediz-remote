import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import express from 'express'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  MAX_SIGNALING_MESSAGE_BYTES,
  MINIMUM_SIGNALING_PROTOCOL_VERSION,
  SIGNALING_PROTOCOL_VERSION,
  SIGNALING_SUBPROTOCOL,
  clientMessageSchema,
  type ControlAccessMode,
  type ClientMessage,
  type ServerErrorOperation,
  type ServerMessage,
  type SignalingPayload,
} from '@ediz-remote/protocol'
import {
  createIceConfiguration,
  loadIceServiceOptions,
  type IceServiceOptions,
} from './ice.js'
import {
  BoundedTokenBucketStore,
  isValidTokenBucketLimit,
  type TokenBucketLimit,
} from './rateLimit.js'
import type {
  CoarseClientBucket,
  SecurityAuditEnqueueResult,
  SecurityAuditEventInput,
  SecurityAuditFlushResult,
} from './securityAudit.js'

const SESSION_TTL_MS = 10 * 60 * 1000
const DEFAULT_RECONNECT_GRACE_MS = 30_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
const DEFAULT_ALLOWED_ORIGINS = ['https://app.ediz-remote.local'] as const
const DEFAULT_IP_BUCKET_IDLE_TTL_MS = 15 * 60 * 1000
const MAX_NEGOTIATIONS_PER_LANE = 256
const HTTP_SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), display-capture=(self), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Permitted-Cross-Domain-Policies': 'none',
} as const

interface SignalingSecurityLimits {
  maxConnections: number
  maxConnectionsPerIp: number
  maxSessions: number
  maxSessionsPerIp: number
  maxTrackedIps: number
  ipBucketIdleTtlMs: number
  globalInboundMessages: TokenBucketLimit
  globalInboundBytes: TokenBucketLimit
  inboundMessages: TokenBucketLimit
  inboundBytes: TokenBucketLimit
  globalCreateSession: TokenBucketLimit
  createSession: TokenBucketLimit
  globalJoinSession: TokenBucketLimit
  joinSession: TokenBucketLimit
  globalResumeSession: TokenBucketLimit
  resumeSession: TokenBucketLimit
  globalInvalidMessage: TokenBucketLimit
  invalidSocketMessage: TokenBucketLimit
  invalidMessage: TokenBucketLimit
  globalRefreshIce: TokenBucketLimit
  refreshIce: TokenBucketLimit
  globalSignalMessages: TokenBucketLimit
  signalMessages: TokenBucketLimit
  globalSignalBytes: TokenBucketLimit
  signalBytes: TokenBucketLimit
}

const DEFAULT_SECURITY_LIMITS: SignalingSecurityLimits = {
  maxConnections: 256,
  maxConnectionsPerIp: 16,
  maxSessions: 96,
  maxSessionsPerIp: 4,
  maxTrackedIps: 4_096,
  ipBucketIdleTtlMs: DEFAULT_IP_BUCKET_IDLE_TTL_MS,
  globalInboundMessages: { capacity: 4_096, refillPerSecond: 1_024 },
  globalInboundBytes: {
    capacity: 32 * 1024 * 1024,
    refillPerSecond: 8 * 1024 * 1024,
  },
  inboundMessages: { capacity: 256, refillPerSecond: 64 },
  inboundBytes: {
    capacity: 2 * 1024 * 1024,
    refillPerSecond: 512 * 1024,
  },
  globalCreateSession: { capacity: 32, refillPerSecond: 1 },
  createSession: { capacity: 4, refillPerSecond: 1 / 15 },
  globalJoinSession: { capacity: 120, refillPerSecond: 2 },
  joinSession: { capacity: 8, refillPerSecond: 8 / 60 },
  globalResumeSession: { capacity: 120, refillPerSecond: 5 },
  resumeSession: { capacity: 12, refillPerSecond: 1 },
  globalInvalidMessage: { capacity: 256, refillPerSecond: 8 },
  invalidSocketMessage: { capacity: 4, refillPerSecond: 1 / 10 },
  invalidMessage: { capacity: 8, refillPerSecond: 1 / 10 },
  globalRefreshIce: { capacity: 128, refillPerSecond: 4 },
  refreshIce: { capacity: 4, refillPerSecond: 1 / 15 },
  globalSignalMessages: { capacity: 4_096, refillPerSecond: 1_024 },
  signalMessages: { capacity: 128, refillPerSecond: 32 },
  globalSignalBytes: {
    capacity: 16 * 1024 * 1024,
    refillPerSecond: 4 * 1024 * 1024,
  },
  signalBytes: {
    capacity: 512 * 1024,
    refillPerSecond: 128 * 1024,
  },
}

type ClientRole = 'host' | 'guest'

interface ClientState {
  id: string
  connectionId: string
  role?: ClientRole
  code?: string
  ip: string
}

interface SessionMember {
  id: string
  role: ClientRole
  socket?: WebSocket
  resumeTokenHash?: string
}

interface PendingGuest {
  requestId: string
  socket: WebSocket
}

type NegotiationLane = 'peer' | 'native-video'

interface NegotiationState {
  currentId?: string
  answerReceived: boolean
  seenIds: Set<string>
}

type NegotiationSignalDisposition = 'accepted' | 'stale' | 'exhausted'

interface Session {
  code: string
  ownerIp: string
  host: SessionMember
  expiresAt: number
  pending?: PendingGuest
  guest?: SessionMember
  accessMode?: ControlAccessMode
  reconnectUntil?: number
  reconnectTimer?: NodeJS.Timeout
  negotiations: Record<NegotiationLane, NegotiationState>
}

interface ResumeIndexEntry {
  session: Session
  member: SessionMember
}

export interface SignalingSecurityOptions {
  maxConnections?: number
  maxConnectionsPerIp?: number
  maxSessions?: number
  maxSessionsPerIp?: number
  maxTrackedIps?: number
  ipBucketIdleTtlMs?: number
  globalInboundMessages?: TokenBucketLimit
  globalInboundBytes?: TokenBucketLimit
  inboundMessages?: TokenBucketLimit
  inboundBytes?: TokenBucketLimit
  globalCreateSession?: TokenBucketLimit
  createSession?: TokenBucketLimit
  globalJoinSession?: TokenBucketLimit
  joinSession?: TokenBucketLimit
  globalResumeSession?: TokenBucketLimit
  resumeSession?: TokenBucketLimit
  globalInvalidMessage?: TokenBucketLimit
  invalidSocketMessage?: TokenBucketLimit
  invalidMessage?: TokenBucketLimit
  globalRefreshIce?: TokenBucketLimit
  refreshIce?: TokenBucketLimit
  globalSignalMessages?: TokenBucketLimit
  signalMessages?: TokenBucketLimit
  globalSignalBytes?: TokenBucketLimit
  signalBytes?: TokenBucketLimit
}

export interface SignalingServerOptions {
  port?: number
  host?: string
  staticDir?: string | null
  now?: () => number
  ice?: IceServiceOptions
  reconnectGraceMs?: number
  heartbeatIntervalMs?: number
  allowedOrigins?: readonly string[]
  trustCloudflareConnectingIp?: boolean
  security?: SignalingSecurityOptions
  audit?: SecurityAuditRecorder | null
}

export interface SecurityAuditRecorder {
  readonly status: Pick<SecurityAuditFlushResult, 'ok'>
  initialize: () => Promise<SecurityAuditFlushResult>
  bucketClientIp: (clientIp: string) => CoarseClientBucket | null
  record: (event: SecurityAuditEventInput) => SecurityAuditEnqueueResult
  close: () => Promise<SecurityAuditFlushResult>
}

export interface SignalingServer {
  httpServer: Server
  start: () => Promise<number>
  stop: () => Promise<void>
}

type SecurityAuditEventDetails = SecurityAuditEventInput extends infer Event
  ? Event extends SecurityAuditEventInput
    ? Omit<Event, 'coarseClientBucket'>
    : never
  : never

type SessionEndAuditDetails = Extract<
  SecurityAuditEventDetails,
  { eventType: 'session_ended' }
>

export function createSignalingServer(
  options: SignalingServerOptions = {},
): SignalingServer {
  const app = express()
  const httpServer = createServer(app)
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_SIGNALING_MESSAGE_BYTES,
    handleProtocols: (protocols) =>
      protocols.has(SIGNALING_SUBPROTOCOL) ? SIGNALING_SUBPROTOCOL : false,
  })
  const clients = new Map<WebSocket, ClientState>()
  const sessions = new Map<string, Session>()
  const resumeIndex = new Map<string, ResumeIndexEntry>()
  const connectionCountsByIp = new Map<string, number>()
  const sessionCountsByIp = new Map<string, number>()
  const now = options.now ?? Date.now
  const ice = options.ice ?? loadIceServiceOptions()
  const security = loadSecurityLimits(options.security)
  const globalRateLimits = new BoundedTokenBucketStore(
    1,
    security.ipBucketIdleTtlMs,
  )
  const ipRateLimits = new BoundedTokenBucketStore(
    security.maxTrackedIps,
    security.ipBucketIdleTtlMs,
  )
  const socketRateLimits = new BoundedTokenBucketStore(
    security.maxConnections,
    security.ipBucketIdleTtlMs,
  )
  const memberRateLimits = new BoundedTokenBucketStore(
    security.maxSessions * 2,
    security.ipBucketIdleTtlMs,
  )
  const allowedOrigins = loadAllowedOrigins(
    options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS,
  )
  const reconnectGraceMs =
    options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS
  if (reconnectGraceMs < 1_000 || reconnectGraceMs > 120_000) {
    throw new Error('reconnectGraceMs 1000-120000 aralığında olmalıdır.')
  }
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  if (heartbeatIntervalMs < 100 || heartbeatIntervalMs > 60_000) {
    throw new Error('heartbeatIntervalMs 100-60000 aralığında olmalıdır.')
  }
  const heartbeatAcknowledged = new WeakMap<WebSocket, boolean>()
  const securityAudit = options.audit ?? null
  let stopping = false
  let startPromise: Promise<number> | undefined
  let stopPromise: Promise<void> | undefined
  let auditClosePromise: Promise<boolean> | undefined
  let auditInitialized = securityAudit === null
  let auditInitializationFailed = false
  let auditOperational = true

  function recordSecurityAudit(
    details: SecurityAuditEventDetails,
    clientIp?: string,
  ): boolean {
    if (!securityAudit) return true
    let coarseClientBucket: CoarseClientBucket | null = null
    if (clientIp) {
      try {
        coarseClientBucket = securityAudit.bucketClientIp(clientIp)
      } catch {
        auditOperational = false
        return false
      }
    }
    try {
      const result = securityAudit.record({
        ...details,
        coarseClientBucket,
      } as SecurityAuditEventInput)
      if (result.accepted) return true
      if (
        result.reason === 'emission_limited' &&
        isSuppressibleSecurityAuditEvent(details.eventType)
      ) {
        return true
      }
      auditOperational = false
      return false
    } catch {
      // Runtime audit failures must never expose their exception or payload.
      auditOperational = false
      return false
    }
  }

  async function initializeSecurityAudit(): Promise<boolean> {
    if (!securityAudit) return true
    try {
      const initialized = (await securityAudit.initialize()).ok
      return initialized && isSecurityAuditHealthy()
    } catch {
      return false
    }
  }

  function closeSecurityAudit(): Promise<boolean> {
    if (!securityAudit) return Promise.resolve(true)
    auditClosePromise ??= Promise.resolve()
      .then(() => securityAudit.close())
      .then((result) => result.ok)
      .catch(() => false)
    return auditClosePromise
  }

  function isSecurityAuditHealthy(): boolean {
    if (!securityAudit) return true
    if (!auditOperational) return false
    try {
      return securityAudit.status.ok
    } catch {
      return false
    }
  }

  app.disable('x-powered-by')
  app.use((_request, response, next) => {
    for (const [name, value] of Object.entries(HTTP_SECURITY_HEADERS)) {
      response.setHeader(name, value)
    }
    next()
  })
  app.get('/health', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (!isSecurityAuditHealthy()) {
      response.status(503).json({ status: 'unavailable' })
      return
    }
    response.json({ status: 'ok', sessions: sessions.size })
  })

  const staticDir = options.staticDir
    ? resolve(options.staticDir)
    : resolve(process.cwd(), 'apps/web/dist')

  if (options.staticDir !== null && existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: 'index.html' }))
    app.get('*splat', (_request, response) => {
      response.sendFile(resolve(staticDir, 'index.html'))
    })
  }

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }

    if (stopping || !isSecurityAuditHealthy()) {
      rejectWebSocketUpgrade(socket, 503, 'Service Unavailable', 5)
      return
    }

    const ip = resolveClientIp(
      request.socket.remoteAddress,
      request.headers['cf-connecting-ip'],
      options.trustCloudflareConnectingIp === true,
    )

    if (!hasSupportedSubprotocol(request.headers['sec-websocket-protocol'])) {
      if (!recordSecurityAudit(
        {
          eventType: 'upgrade_rejected',
          outcome: 'rejected',
          role: 'unknown',
          reasonCode: 'unsupported_protocol',
        },
        ip,
      )) {
        rejectWebSocketUpgrade(socket, 503, 'Service Unavailable', 5)
        return
      }
      rejectWebSocketUpgrade(socket, 426, 'Upgrade Required')
      return
    }

    if (
      !isAllowedWebSocketOrigin(
        request.headers.origin,
        request.headers.host,
        allowedOrigins,
      )
    ) {
      if (!recordSecurityAudit(
        {
          eventType: 'upgrade_rejected',
          outcome: 'rejected',
          role: 'unknown',
          reasonCode: 'invalid_origin',
        },
        ip,
      )) {
        rejectWebSocketUpgrade(socket, 503, 'Service Unavailable', 5)
        return
      }
      rejectWebSocketUpgrade(socket, 403, 'Forbidden')
      return
    }

    if (websocketServer.clients.size >= security.maxConnections) {
      rejectWebSocketUpgrade(socket, 503, 'Service Unavailable', 5)
      return
    }
    if (
      (connectionCountsByIp.get(ip) ?? 0) >= security.maxConnectionsPerIp
    ) {
      rejectWebSocketUpgrade(socket, 429, 'Too Many Requests', 5)
      return
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request)
    })
  })

  websocketServer.on('connection', (socket, request) => {
    if (stopping || !isSecurityAuditHealthy()) {
      socket.terminate()
      return
    }
    const ip = resolveClientIp(
      request.socket.remoteAddress,
      request.headers['cf-connecting-ip'],
      options.trustCloudflareConnectingIp === true,
    )

    const connectionId = randomUUID()
    const state: ClientState = {
      id: randomUUID(),
      connectionId,
      ip,
    }
    clients.set(socket, state)
    incrementCount(connectionCountsByIp, ip)
    heartbeatAcknowledged.set(socket, true)
    socket.on('pong', () => heartbeatAcknowledged.set(socket, true))
    send(socket, {
      type: 'ready',
      clientId: state.id,
      protocolVersion: SIGNALING_PROTOCOL_VERSION,
      minimumProtocolVersion: MINIMUM_SIGNALING_PROTOCOL_VERSION,
    })

    socket.on('message', (data, isBinary) =>
      handleRawMessage(socket, data, isBinary),
    )
    socket.on('close', () => removeClient(socket))
    socket.on('error', () => removeClient(socket))
  })

  function handleRawMessage(
    socket: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (stopping || !isSecurityAuditHealthy()) {
      socket.terminate()
      return
    }
    const messageBytes = rawDataByteLength(data)
    if (
      !consumeSocketAndGlobalRate(
        socket,
        'inbound-messages',
        security.inboundMessages,
        security.globalInboundMessages,
      ) ||
      !consumeSocketAndGlobalRate(
        socket,
        'inbound-bytes',
        security.inboundBytes,
        security.globalInboundBytes,
        messageBytes,
      )
    ) {
      socket.terminate()
      return
    }

    if (isBinary) {
      rejectInvalidMessage(
        socket,
        'Yalnızca JSON metin mesajı kabul edilir.',
      )
      return
    }
    let json: unknown
    try {
      json = JSON.parse(data.toString())
    } catch {
      rejectInvalidMessage(socket, 'Mesaj JSON biçiminde olmalıdır.')
      return
    }

    const result = clientMessageSchema.safeParse(json)
    if (!result.success) {
      rejectInvalidMessage(socket, 'Mesaj biçimi geçersiz.')
      return
    }

    handleMessage(socket, result.data, messageBytes)
  }

  function handleMessage(
    socket: WebSocket,
    message: ClientMessage,
    messageBytes: number,
  ): void {
    switch (message.type) {
      case 'create_session':
        createSession(socket)
        break
      case 'join_session':
        joinSession(socket, message.code)
        break
      case 'request_decision':
        decideRequest(
          socket,
          message.requestId,
          message.approved,
          message.accessMode,
        )
        break
      case 'resume_session':
        resumeSession(socket, message.token)
        break
      case 'refresh_ice':
        refreshIce(socket)
        break
      case 'revoke_control':
        revokeControl(socket)
        break
      case 'signal':
        relaySignal(socket, message.payload, messageBytes)
        break
      case 'leave_session':
        leaveSession(socket)
        break
      case 'ping':
        send(socket, { type: 'pong' })
        break
    }
  }

  function createSession(hostSocket: WebSocket): void {
    const state = clients.get(hostSocket)
    if (!state) return
    if (
      !consumeIpAndGlobalRate(
        state.ip,
        'create-session',
        security.createSession,
        security.globalCreateSession,
      )
    ) {
      sendRateLimited(
        hostSocket,
        'create_session',
        'Çok fazla yeni oturum isteği gönderildi. Lütfen biraz bekleyin.',
        15,
      )
      return
    }

    const currentSession = state.code ? sessions.get(state.code) : undefined
    const replacesOwnSession = currentSession?.host.socket === hostSocket
    const projectedSessionCount =
      sessions.size - (replacesOwnSession ? 1 : 0)
    const projectedIpSessionCount =
      (sessionCountsByIp.get(state.ip) ?? 0) -
      (replacesOwnSession && currentSession.ownerIp === state.ip ? 1 : 0)
    if (
      projectedSessionCount >= security.maxSessions ||
      projectedIpSessionCount >= security.maxSessionsPerIp
    ) {
      sendCapacityExceeded(
        hostSocket,
        'Oturum kapasitesi dolu. Mevcut oturumları kapatıp yeniden deneyin.',
        5,
      )
      return
    }

    const code = generateUniqueCode(sessions)
    const expiresAt = now() + SESSION_TTL_MS
    leaveSession(hostSocket, 'replaced')
    if (!isSecurityAuditHealthy()) {
      hostSocket.terminate()
      return
    }
    sessions.set(code, {
      code,
      ownerIp: state.ip,
      host: {
        id: state.id,
        role: 'host',
        socket: hostSocket,
      },
      expiresAt,
      negotiations: {
        peer: createNegotiationState(),
        'native-video': createNegotiationState(),
      },
    })
    incrementCount(sessionCountsByIp, state.ip)
    Object.assign(state, { role: 'host' as const, code })
    send(hostSocket, {
      type: 'session_created',
      code,
      expiresAt: new Date(expiresAt).toISOString(),
    })
  }

  function joinSession(guestSocket: WebSocket, code: string): void {
    const state = clients.get(guestSocket)
    if (!state) return

    if (
      !consumeIpAndGlobalRate(
        state.ip,
        'join-session',
        security.joinSession,
        security.globalJoinSession,
      )
    ) {
      if (!recordSecurityAudit(
        {
          eventType: 'join_rate_limited',
          outcome: 'rate_limited',
          role: 'unknown',
          reasonCode: 'rate_limited',
        },
        state.ip,
      )) {
        guestSocket.terminate()
        return
      }
      sendRateLimited(
        guestSocket,
        'join_session',
        'Çok fazla deneme yaptınız. Bir dakika bekleyin.',
        8,
      )
      return
    }

    leaveSession(guestSocket)
    if (!isSecurityAuditHealthy()) {
      guestSocket.terminate()
      return
    }
    const session = sessions.get(code)
    const hostSocket = session?.host.socket
    if (!session || !hostSocket || session.expiresAt <= now()) {
      // Onaylı oturumu (askıdaki host dahil) kod bilgisi sonlandıramaz; kod TTL'i
      // yalnız kullanılmamış kodu, grace ise reconnect zamanlayıcısı bitirir.
      if (session && !session.guest) expireSession(session)
      if (!recordSecurityAudit(
        {
          eventType: 'join_rejected',
          outcome: 'rejected',
          role: 'unknown',
          reasonCode: 'invalid_or_expired',
        },
        state.ip,
      )) {
        guestSocket.terminate()
        return
      }
      sendError(
        guestSocket,
        'invalid_code',
        'Bağlantı kodu bulunamadı veya süresi doldu.',
      )
      return
    }

    if (session.pending || session.guest) {
      if (!recordSecurityAudit(
        {
          eventType: 'join_rejected',
          outcome: 'rejected',
          role: 'unknown',
          reasonCode: 'session_busy',
        },
        state.ip,
      )) {
        guestSocket.terminate()
        return
      }
      sendError(
        guestSocket,
        'session_busy',
        'Bu bağlantı kodu şu anda kullanımda.',
      )
      return
    }

    const requestId = randomUUID()
    session.pending = { requestId, socket: guestSocket }
    Object.assign(state, { role: 'guest' as const, code })
    send(guestSocket, { type: 'join_pending', code, requestId })
    send(hostSocket, { type: 'incoming_request', requestId })
  }

  function decideRequest(
    hostSocket: WebSocket,
    requestId: string,
    approved: boolean,
    accessMode?: ControlAccessMode,
  ): void {
    const state = clients.get(hostSocket)
    const session = state?.code ? sessions.get(state.code) : undefined
    if (session && session.expiresAt <= now()) {
      expireSession(session)
      if (!isSecurityAuditHealthy()) {
        hostSocket.terminate()
        return
      }
      sendError(hostSocket, 'not_authorized', 'Bağlantı kodunun süresi doldu.')
      return
    }

    if (
      !state ||
      !session ||
      session.host.socket !== hostSocket ||
      session.pending?.requestId !== requestId
    ) {
      sendError(
        hostSocket,
        'not_authorized',
        'Bu bağlantı isteği artık geçerli değil.',
      )
      return
    }

    const guestSocket = session.pending.socket
    if (!approved) {
      if (!recordSecurityAudit(
        {
          eventType: 'approval_rejected',
          outcome: 'rejected',
          role: 'host',
          reasonCode: 'host_decision',
        },
        state.ip,
      )) {
        hostSocket.terminate()
        guestSocket.terminate()
        return
      }
      session.pending = undefined
      clearClientSession(guestSocket)
      send(guestSocket, { type: 'request_rejected' })
      return
    }

    if (guestSocket.readyState !== WebSocket.OPEN || !accessMode) {
      session.pending = undefined
      return
    }
    const guestState = clients.get(guestSocket)
    if (!guestState) {
      session.pending = undefined
      return
    }

    if (!recordSecurityAudit(
      {
        eventType: 'approval_granted',
        outcome: 'allowed',
        role: 'host',
        reasonCode: 'host_decision',
      },
      state.ip,
    )) {
      hostSocket.terminate()
      guestSocket.terminate()
      return
    }

    const guest: SessionMember = {
      id: guestState.id,
      role: 'guest',
      socket: guestSocket,
    }
    session.pending = undefined
    session.guest = guest
    session.accessMode = accessMode
    const hostResumeToken = rotateResumeToken(session, session.host)
    const guestResumeToken = rotateResumeToken(session, guest)
    const reconnectGraceSeconds = Math.ceil(reconnectGraceMs / 1_000)

    send(guestSocket, {
      type: 'session_approved',
      code: session.code,
      peerId: session.host.id,
      accessMode,
      iceConfiguration: createIceConfiguration(guest.id, now(), ice),
      resumeToken: guestResumeToken,
      reconnectGraceSeconds,
    })
    send(hostSocket, {
      type: 'peer_joined',
      peerId: guest.id,
      accessMode,
      iceConfiguration: createIceConfiguration(session.host.id, now(), ice),
      resumeToken: hostResumeToken,
      reconnectGraceSeconds,
    })
  }

  function resumeSession(socket: WebSocket, token: string): void {
    const state = clients.get(socket)
    if (!state) return
    if (
      !consumeIpAndGlobalRate(
        state.ip,
        'resume-session',
        security.resumeSession,
        security.globalResumeSession,
      )
    ) {
      if (!recordSecurityAudit(
        {
          eventType: 'resume_rejected',
          outcome: 'rate_limited',
          role: 'unknown',
          reasonCode: 'rate_limited',
        },
        state.ip,
      )) {
        socket.terminate()
        return
      }
      sendRateLimited(
        socket,
        'resume_session',
        'Çok fazla oturum kurtarma isteği gönderildi. Lütfen biraz bekleyin.',
        1,
      )
      return
    }

    if (state.code || state.role) {
      if (!recordSecurityAudit(
        {
          eventType: 'resume_rejected',
          outcome: 'rejected',
          role: 'unknown',
          reasonCode: 'invalid_resume',
        },
        state.ip,
      )) {
        socket.terminate()
        return
      }
      sendError(
        socket,
        'invalid_resume',
        'Oturum kurtarma yalnızca yeni bir bağlantı üzerinden yapılabilir.',
      )
      return
    }

    const tokenHash = hashResumeToken(token)
    const match = findResumeMember(tokenHash)
    const replacingActiveSocket = Boolean(
      match?.member.socket && match.member.socket !== socket,
    )
    const resumingWithinGrace = Boolean(
      match &&
        !match.member.socket &&
        match.session.reconnectUntil &&
        match.session.reconnectUntil > now(),
    )
    if (!match || (!replacingActiveSocket && !resumingWithinGrace)) {
      if (!recordSecurityAudit(
        {
          eventType: 'resume_rejected',
          outcome: 'rejected',
          role: 'unknown',
          reasonCode: 'invalid_resume',
        },
        state.ip,
      )) {
        socket.terminate()
        return
      }
      sendError(
        socket,
        'invalid_resume',
        'Oturum kurtarma anahtarı geçersiz veya süresi dolmuş.',
      )
      return
    }

    const { session, member } = match
    const replacedSocket = member.socket
    if (!recordSecurityAudit(
      {
        eventType: 'resume_succeeded',
        outcome: 'allowed',
        role: member.role,
        reasonCode: replacingActiveSocket
          ? 'active_takeover'
          : 'grace_recovery',
      },
      state.ip,
    )) {
      socket.terminate()
      return
    }
    member.socket = socket
    state.id = member.id
    state.role = member.role
    state.code = session.code
    const resumeToken = rotateResumeToken(session, member)
    const peer = member.role === 'host' ? session.guest : session.host
    const peerConnected = peer?.socket?.readyState === WebSocket.OPEN

    if (replacedSocket && replacedSocket !== socket) {
      replacedSocket.terminate()
    }

    if (peerConnected) {
      clearReconnectDeadline(session)
    }

    send(socket, {
      type: 'session_resumed',
      role: member.role,
      code: session.code,
      peerId: peer?.id ?? '',
      accessMode: session.accessMode!,
      resumeToken,
      peerConnected,
      reconnectGraceSeconds: Math.ceil(reconnectGraceMs / 1_000),
      iceConfiguration: createIceConfiguration(member.id, now(), ice),
    })

    if (peerConnected && peer?.socket) {
      send(peer.socket, {
        type: 'peer_resumed',
        peerId: member.id,
        iceConfiguration: createIceConfiguration(peer.id, now(), ice),
      })
    }
  }

  function refreshIce(socket: WebSocket): void {
    const membership = findActiveMembership(socket)
    if (!membership) {
      const state = clients.get(socket)
      if (
        state &&
        !consumeIpAndGlobalRate(
          state.ip,
          'unauthorized-refresh-ice',
          security.refreshIce,
          security.globalRefreshIce,
        )
      ) {
        sendRateLimited(
          socket,
          'refresh_ice',
          'ICE yapılandırması çok sık yenileniyor. Lütfen biraz bekleyin.',
          15,
        )
        return
      }
      sendError(
        socket,
        'not_authorized',
        'ICE yapılandırmasını yenilemek için onaylı oturum gerekir.',
      )
      return
    }
    if (
      !consumeMemberAndGlobalRate(
        membership.member,
        'refresh-ice',
        security.refreshIce,
        security.globalRefreshIce,
      )
    ) {
      sendRateLimited(
        socket,
        'refresh_ice',
        'ICE yapılandırması çok sık yenileniyor. Lütfen biraz bekleyin.',
        15,
      )
      return
    }
    send(socket, {
      type: 'ice_configuration',
      iceConfiguration: createIceConfiguration(membership.member.id, now(), ice),
    })
  }

  function revokeControl(socket: WebSocket): void {
    const membership = findActiveMembership(socket)
    if (
      !membership ||
      membership.member.role !== 'host' ||
      membership.session.host.socket !== socket
    ) {
      sendError(
        socket,
        'not_authorized',
        'Kontrol yetkisini yalnızca aktif oturumun host cihazı geri alabilir.',
      )
      return
    }

    if (membership.session.accessMode === 'control') {
      membership.session.accessMode = 'view'
      const state = clients.get(socket)
      if (!recordSecurityAudit(
        {
          eventType: 'control_revoked',
          outcome: 'allowed',
          role: 'host',
          reasonCode: 'host_request',
        },
        state?.ip,
      )) {
        socket.terminate()
      }
    }
  }

  function relaySignal(
    sender: WebSocket,
    payload: SignalingPayload,
    messageBytes: number,
  ): void {
    const membership = findActiveMembership(sender)
    if (!membership) {
      const state = clients.get(sender)
      if (
        state &&
        !consumeIpAndGlobalRate(
          state.ip,
          'unauthorized-signal',
          security.signalMessages,
          security.globalSignalMessages,
        )
      ) {
        sendRateLimited(
          sender,
          'signal',
          'Sinyalleşme trafiği geçici olarak sınırlandı. Lütfen biraz bekleyin.',
          1,
        )
        return
      }
      sendError(
        sender,
        'not_authorized',
        'Sinyal göndermek için onaylanmış bir oturum gerekir.',
      )
      return
    }

    if (
      !consumeMemberAndGlobalRate(
        membership.member,
        'signal-messages',
        security.signalMessages,
        security.globalSignalMessages,
      ) ||
      !consumeMemberAndGlobalRate(
        membership.member,
        'signal-bytes',
        security.signalBytes,
        security.globalSignalBytes,
        messageBytes,
      )
    ) {
      sendRateLimited(
        sender,
        'signal',
        'Sinyalleşme trafiği geçici olarak sınırlandı. Lütfen biraz bekleyin.',
        1,
      )
      return
    }

    if (!isAllowedSignalDirection(membership.member.role, payload)) {
      sendError(
        sender,
        'not_authorized',
        'Bu rol belirtilen SDP mesaj yönünü gönderemez.',
      )
      return
    }

    const recipient =
      membership.member.role === 'host'
        ? membership.session.guest?.socket
        : membership.session.host.socket
    if (!recipient || recipient.readyState !== WebSocket.OPEN) {
      sendError(
        sender,
        'peer_unavailable',
        'Karşı cihaz yeniden bağlanmayı bekliyor.',
      )
      return
    }

    const negotiationDisposition = acceptNegotiationSignal(
      membership.session,
      membership.member.role,
      payload,
    )
    if (negotiationDisposition === 'stale') return
    if (negotiationDisposition === 'exhausted') {
      sendError(
        sender,
        'negotiation_exhausted',
        'Bu oturumun güvenli bağlantı yenileme sınırına ulaşıldı. Yeni bir bağlantı koduyla tekrar onay alın.',
      )
      return
    }

    send(recipient, {
      type: 'signal',
      from: membership.member.id,
      payload,
    })
  }

  function leaveSession(
    socket: WebSocket,
    hostReason: 'host_left' | 'replaced' = 'host_left',
  ): void {
    const state = clients.get(socket)
    if (!state?.code) return

    const session = sessions.get(state.code)
    if (!session) {
      clearClientSession(socket)
      return
    }

    if (session.host.socket === socket) {
      endSession(session, hostReason, new Set([socket]))
    } else if (session.pending?.socket === socket) {
      session.pending = undefined
      clearClientSession(socket)
    } else if (session.guest?.socket === socket) {
      const hostSocket = session.host.socket
      endSession(
        session,
        'host_left',
        new Set([socket, ...(hostSocket ? [hostSocket] : [])]),
        {
          eventType: 'session_ended',
          outcome: 'ended',
          role: 'guest',
          reasonCode: 'guest_left',
        },
      )
      if (hostSocket) send(hostSocket, { type: 'peer_left' })
    } else {
      clearClientSession(socket)
    }
  }

  function removeClient(socket: WebSocket): void {
    const state = clients.get(socket)
    if (!state) return

    if (stopping) {
      clients.delete(socket)
      decrementCount(connectionCountsByIp, state.ip)
      socketRateLimits.delete(state.connectionId)
      return
    }

    const session = state.code ? sessions.get(state.code) : undefined
    if (session?.guest && session.accessMode) {
      const member =
        session.host.socket === socket
          ? session.host
          : session.guest.socket === socket
            ? session.guest
            : undefined
      if (member) {
        suspendMember(session, member)
      }
    } else {
      leaveSession(socket)
    }
    clients.delete(socket)
    decrementCount(connectionCountsByIp, state.ip)
    socketRateLimits.delete(state.connectionId)
  }

  function suspendMember(session: Session, member: SessionMember): void {
    member.socket = undefined
    if (!session.reconnectUntil) {
      session.reconnectUntil = now() + reconnectGraceMs
      session.reconnectTimer = setTimeout(
        () => expireReconnectSession(session),
        reconnectGraceMs,
      )
      session.reconnectTimer.unref()
    }
    const peer = member.role === 'host' ? session.guest : session.host
    if (peer?.socket) {
      send(peer.socket, {
        type: 'peer_suspended',
        reconnectUntil: new Date(session.reconnectUntil).toISOString(),
      })
    }
  }

  function expireReconnectSession(session: Session): void {
    if (!sessions.has(session.code)) return
    if (session.host.socket && session.guest?.socket) {
      clearReconnectDeadline(session)
      return
    }
    endSession(session, 'reconnect_timeout')
  }

  function clearReconnectDeadline(session: Session): void {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
    delete session.reconnectTimer
    delete session.reconnectUntil
  }

  function findActiveMembership(
    socket: WebSocket,
  ): { session: Session; member: SessionMember } | undefined {
    const state = clients.get(socket)
    const session = state?.code ? sessions.get(state.code) : undefined
    if (!session?.guest || !session.accessMode) return undefined
    if (session.host.socket === socket) {
      return { session, member: session.host }
    }
    if (session.guest.socket === socket) {
      return { session, member: session.guest }
    }
    return undefined
  }

  function findResumeMember(
    tokenHash: string,
  ): { session: Session; member: SessionMember } | undefined {
    const match = resumeIndex.get(tokenHash)
    if (!match) return undefined
    const { session, member } = match
    if (
      sessions.get(session.code) !== session ||
      !session.guest ||
      !session.accessMode ||
      member.resumeTokenHash !== tokenHash ||
      (member !== session.host && member !== session.guest)
    ) {
      resumeIndex.delete(tokenHash)
      return undefined
    }
    return match
  }

  function rotateResumeToken(
    session: Session,
    member: SessionMember,
  ): string {
    if (member.resumeTokenHash) resumeIndex.delete(member.resumeTokenHash)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = randomBytes(32).toString('base64url')
      const tokenHash = hashResumeToken(token)
      if (resumeIndex.has(tokenHash)) continue
      member.resumeTokenHash = tokenHash
      resumeIndex.set(tokenHash, { session, member })
      return token
    }
    delete member.resumeTokenHash
    throw new Error('Benzersiz reconnect token üretilemedi.')
  }

  function clearClientSession(socket: WebSocket): void {
    const state = clients.get(socket)
    if (!state) return
    delete state.code
    delete state.role
  }

  function expireSession(session: Session): void {
    endSession(session, 'expired')
  }

  function sessionEndAuditDetails(
    reason: Extract<ServerMessage, { type: 'session_ended' }>['reason'],
  ): SessionEndAuditDetails {
    if (reason === 'host_left') {
      return {
        eventType: 'session_ended',
        outcome: 'ended',
        role: 'host',
        reasonCode: 'host_left',
      }
    }
    return {
      eventType: 'session_ended',
      outcome: 'ended',
      role: 'system',
      reasonCode: reason,
    }
  }

  function endSession(
    session: Session,
    reason: Extract<
      ServerMessage,
      { type: 'session_ended' }
    >['reason'],
    excludedSockets: ReadonlySet<WebSocket> = new Set(),
    auditDetails: SessionEndAuditDetails = sessionEndAuditDetails(reason),
  ): void {
    if (!sessions.delete(session.code)) return
    const auditClientIp =
      auditDetails.role === 'host'
        ? session.ownerIp
        : auditDetails.role === 'guest' && session.guest?.socket
          ? clients.get(session.guest.socket)?.ip
          : undefined
    recordSecurityAudit(auditDetails, auditClientIp)
    decrementCount(sessionCountsByIp, session.ownerIp)
    for (const member of [session.host, session.guest]) {
      if (!member) continue
      memberRateLimits.delete(member.id)
      if (member.resumeTokenHash) {
        resumeIndex.delete(member.resumeTokenHash)
        delete member.resumeTokenHash
      }
    }
    clearReconnectDeadline(session)
    const sockets = [
      session.host.socket,
      session.pending?.socket,
      session.guest?.socket,
    ]
    for (const memberSocket of sockets) {
      if (!memberSocket) continue
      clearClientSession(memberSocket)
      if (!excludedSockets.has(memberSocket)) {
        send(memberSocket, { type: 'session_ended', reason })
      }
    }
    session.host.socket = undefined
    if (session.guest) session.guest.socket = undefined
    session.pending = undefined
  }

  function consumeIpRate(
    ip: string,
    bucketName: string,
    limit: TokenBucketLimit,
    cost = 1,
  ): boolean {
    return ipRateLimits.consume(ip, bucketName, limit, now(), cost)
  }

  function consumeGlobalRate(
    bucketName: string,
    limit: TokenBucketLimit,
    cost = 1,
  ): boolean {
    return globalRateLimits.consume('global', bucketName, limit, now(), cost)
  }

  function consumeIpAndGlobalRate(
    ip: string,
    bucketName: string,
    ipLimit: TokenBucketLimit,
    globalLimit: TokenBucketLimit,
    cost = 1,
  ): boolean {
    return (
      consumeIpRate(ip, bucketName, ipLimit, cost) &&
      consumeGlobalRate(bucketName, globalLimit, cost)
    )
  }

  function consumeSocketRate(
    socket: WebSocket,
    bucketName: string,
    limit: TokenBucketLimit,
    cost = 1,
  ): boolean {
    const state = clients.get(socket)
    if (!state) return false
    return socketRateLimits.consume(
      state.connectionId,
      bucketName,
      limit,
      now(),
      cost,
    )
  }

  function consumeSocketAndGlobalRate(
    socket: WebSocket,
    bucketName: string,
    socketLimit: TokenBucketLimit,
    globalLimit: TokenBucketLimit,
    cost = 1,
  ): boolean {
    return (
      consumeSocketRate(socket, bucketName, socketLimit, cost) &&
      consumeGlobalRate(bucketName, globalLimit, cost)
    )
  }

  function consumeMemberRate(
    member: SessionMember,
    bucketName: string,
    limit: TokenBucketLimit,
    cost = 1,
  ): boolean {
    return memberRateLimits.consume(member.id, bucketName, limit, now(), cost)
  }

  function consumeMemberAndGlobalRate(
    member: SessionMember,
    bucketName: string,
    memberLimit: TokenBucketLimit,
    globalLimit: TokenBucketLimit,
    cost = 1,
  ): boolean {
    return (
      consumeMemberRate(member, bucketName, memberLimit, cost) &&
      consumeGlobalRate(bucketName, globalLimit, cost)
    )
  }

  function rejectInvalidMessage(socket: WebSocket, message: string): void {
    const state = clients.get(socket)
    if (
      !state ||
      !consumeSocketRate(
        socket,
        'invalid-message',
        security.invalidSocketMessage,
      ) ||
      !consumeIpRate(state.ip, 'invalid-message', security.invalidMessage) ||
      !consumeGlobalRate(
        'invalid-message',
        security.globalInvalidMessage,
      )
    ) {
      socket.terminate()
      return
    }
    sendError(socket, 'invalid_message', message)
  }

  function sendRateLimited(
    socket: WebSocket,
    operation: ServerErrorOperation,
    message: string,
    retryAfterSeconds: number,
  ): void {
    send(socket, {
      type: 'error',
      code: 'rate_limited',
      message,
      operation,
      retryAfterSeconds,
    })
  }

  function sendCapacityExceeded(
    socket: WebSocket,
    message: string,
    retryAfterSeconds: number,
  ): void {
    send(socket, {
      type: 'error',
      code: 'capacity_exceeded',
      message,
      operation: 'create_session',
      retryAfterSeconds,
    })
  }

  const cleanupTimer = setInterval(() => {
    for (const session of sessions.values()) {
      if (!session.guest && session.expiresAt <= now()) expireSession(session)
    }
    globalRateLimits.sweep(now())
    ipRateLimits.sweep(now())
    socketRateLimits.sweep(now())
    memberRateLimits.sweep(now())
  }, 30_000)
  cleanupTimer.unref()

  const heartbeatTimer = setInterval(() => {
    for (const socket of websocketServer.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue
      if (heartbeatAcknowledged.get(socket) === false) {
        socket.terminate()
        continue
      }
      heartbeatAcknowledged.set(socket, false)
      socket.ping()
    }
  }, heartbeatIntervalMs)
  heartbeatTimer.unref()

  async function startServer(): Promise<number> {
    const auditReady = await initializeSecurityAudit()
    if (!auditReady) {
      auditInitializationFailed = true
      await closeSecurityAudit()
      throw new Error('Güvenlik audit katmanı başlatılamadı.')
    }
    auditInitialized = true
    if (stopping) {
      throw new Error('Signaling sunucusu durduruluyor.')
    }

    return new Promise((resolveStart, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(options.port ?? 8080, options.host ?? '0.0.0.0', () => {
        httpServer.off('error', reject)
        const address = httpServer.address()
        resolveStart(typeof address === 'object' && address ? address.port : 0)
      })
    })
  }

  async function stopServer(): Promise<void> {
    stopping = true
    clearInterval(cleanupTimer)
    clearInterval(heartbeatTimer)

    if (startPromise) {
      try {
        await startPromise
      } catch {
        // Startup already reports a fixed error; shutdown still completes.
      }
    }

    for (const session of sessions.values()) {
      const excludedSockets = new Set(
        [
          session.host.socket,
          session.pending?.socket,
          session.guest?.socket,
        ].filter((socket): socket is WebSocket => socket !== undefined),
      )
      endSession(session, 'host_left', excludedSockets, {
        eventType: 'session_ended',
        outcome: 'ended',
        role: 'system',
        reasonCode: 'server_shutdown',
      })
    }

    for (const [client, state] of clients) {
      socketRateLimits.delete(state.connectionId)
      client.terminate()
    }
    clients.clear()
    resumeIndex.clear()
    connectionCountsByIp.clear()
    sessionCountsByIp.clear()

    await closeWebSocketServer(websocketServer)
    const httpClosed = await closeHttpServer(httpServer)
    const auditClosed = await closeSecurityAudit()
    if (!httpClosed) {
      throw new Error('Signaling sunucusu güvenli biçimde kapatılamadı.')
    }
    if (!auditClosed && auditInitialized && !auditInitializationFailed) {
      throw new Error('Güvenlik audit katmanı kapatılamadı.')
    }
  }

  return {
    httpServer,
    start: () => {
      if (startPromise) return startPromise
      if (stopping) {
        return Promise.reject(new Error('Signaling sunucusu durduruluyor.'))
      }
      startPromise = startServer()
      return startPromise
    },
    stop: () => {
      stopPromise ??= stopServer()
      return stopPromise
    },
  }
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolveClose) => {
    try {
      server.close(() => resolveClose())
    } catch {
      resolveClose()
    }
  })
}

function closeHttpServer(server: Server): Promise<boolean> {
  if (!server.listening) return Promise.resolve(true)
  return new Promise((resolveClose) => {
    server.close((error) => resolveClose(error === undefined))
  })
}

function isSuppressibleSecurityAuditEvent(
  eventType: SecurityAuditEventInput['eventType'],
): boolean {
  return (
    eventType === 'upgrade_rejected' ||
    eventType === 'join_rate_limited' ||
    eventType === 'join_rejected' ||
    eventType === 'resume_rejected'
  )
}

function loadSecurityLimits(
  configured: SignalingSecurityOptions | undefined,
): SignalingSecurityLimits {
  const limits: SignalingSecurityLimits = {
    maxConnections:
      configured?.maxConnections ?? DEFAULT_SECURITY_LIMITS.maxConnections,
    maxConnectionsPerIp:
      configured?.maxConnectionsPerIp ??
      DEFAULT_SECURITY_LIMITS.maxConnectionsPerIp,
    maxSessions:
      configured?.maxSessions ?? DEFAULT_SECURITY_LIMITS.maxSessions,
    maxSessionsPerIp:
      configured?.maxSessionsPerIp ?? DEFAULT_SECURITY_LIMITS.maxSessionsPerIp,
    maxTrackedIps:
      configured?.maxTrackedIps ?? DEFAULT_SECURITY_LIMITS.maxTrackedIps,
    ipBucketIdleTtlMs:
      configured?.ipBucketIdleTtlMs ??
      DEFAULT_SECURITY_LIMITS.ipBucketIdleTtlMs,
    globalInboundMessages:
      configured?.globalInboundMessages ??
      DEFAULT_SECURITY_LIMITS.globalInboundMessages,
    globalInboundBytes:
      configured?.globalInboundBytes ??
      DEFAULT_SECURITY_LIMITS.globalInboundBytes,
    inboundMessages:
      configured?.inboundMessages ?? DEFAULT_SECURITY_LIMITS.inboundMessages,
    inboundBytes:
      configured?.inboundBytes ?? DEFAULT_SECURITY_LIMITS.inboundBytes,
    globalCreateSession:
      configured?.globalCreateSession ??
      DEFAULT_SECURITY_LIMITS.globalCreateSession,
    createSession:
      configured?.createSession ?? DEFAULT_SECURITY_LIMITS.createSession,
    globalJoinSession:
      configured?.globalJoinSession ??
      DEFAULT_SECURITY_LIMITS.globalJoinSession,
    joinSession:
      configured?.joinSession ?? DEFAULT_SECURITY_LIMITS.joinSession,
    globalResumeSession:
      configured?.globalResumeSession ??
      DEFAULT_SECURITY_LIMITS.globalResumeSession,
    resumeSession:
      configured?.resumeSession ?? DEFAULT_SECURITY_LIMITS.resumeSession,
    globalInvalidMessage:
      configured?.globalInvalidMessage ??
      DEFAULT_SECURITY_LIMITS.globalInvalidMessage,
    invalidSocketMessage:
      configured?.invalidSocketMessage ??
      DEFAULT_SECURITY_LIMITS.invalidSocketMessage,
    invalidMessage:
      configured?.invalidMessage ?? DEFAULT_SECURITY_LIMITS.invalidMessage,
    globalRefreshIce:
      configured?.globalRefreshIce ??
      DEFAULT_SECURITY_LIMITS.globalRefreshIce,
    refreshIce:
      configured?.refreshIce ?? DEFAULT_SECURITY_LIMITS.refreshIce,
    globalSignalMessages:
      configured?.globalSignalMessages ??
      DEFAULT_SECURITY_LIMITS.globalSignalMessages,
    signalMessages:
      configured?.signalMessages ?? DEFAULT_SECURITY_LIMITS.signalMessages,
    globalSignalBytes:
      configured?.globalSignalBytes ??
      DEFAULT_SECURITY_LIMITS.globalSignalBytes,
    signalBytes:
      configured?.signalBytes ?? DEFAULT_SECURITY_LIMITS.signalBytes,
  }

  validatePositiveInteger('maxConnections', limits.maxConnections, 100_000)
  validatePositiveInteger(
    'maxConnectionsPerIp',
    limits.maxConnectionsPerIp,
    limits.maxConnections,
  )
  validatePositiveInteger('maxSessions', limits.maxSessions, 100_000)
  validatePositiveInteger(
    'maxSessionsPerIp',
    limits.maxSessionsPerIp,
    limits.maxSessions,
  )
  validatePositiveInteger('maxTrackedIps', limits.maxTrackedIps, 1_000_000)
  validatePositiveInteger(
    'ipBucketIdleTtlMs',
    limits.ipBucketIdleTtlMs,
    24 * 60 * 60 * 1_000,
  )
  const tokenBucketLimits = {
    globalInboundMessages: limits.globalInboundMessages,
    globalInboundBytes: limits.globalInboundBytes,
    inboundMessages: limits.inboundMessages,
    inboundBytes: limits.inboundBytes,
    globalCreateSession: limits.globalCreateSession,
    createSession: limits.createSession,
    globalJoinSession: limits.globalJoinSession,
    joinSession: limits.joinSession,
    globalResumeSession: limits.globalResumeSession,
    resumeSession: limits.resumeSession,
    globalInvalidMessage: limits.globalInvalidMessage,
    invalidSocketMessage: limits.invalidSocketMessage,
    invalidMessage: limits.invalidMessage,
    globalRefreshIce: limits.globalRefreshIce,
    refreshIce: limits.refreshIce,
    globalSignalMessages: limits.globalSignalMessages,
    signalMessages: limits.signalMessages,
    globalSignalBytes: limits.globalSignalBytes,
    signalBytes: limits.signalBytes,
  }
  for (const [name, limit] of Object.entries(tokenBucketLimits)) {
    if (!isValidTokenBucketLimit(limit)) {
      throw new Error(`${name} token bucket yapılandırması geçersiz.`)
    }
  }
  const longestRefillMs = Math.ceil(
    Math.max(
      ...Object.values(tokenBucketLimits).map(
        (limit) => (limit.capacity / limit.refillPerSecond) * 1_000,
      ),
    ),
  )
  if (limits.ipBucketIdleTtlMs < longestRefillMs) {
    throw new Error(
      `ipBucketIdleTtlMs en az ${longestRefillMs} olmalıdır; aksi halde oran borcu TTL ile sıfırlanır.`,
    )
  }
  return limits
}

function validatePositiveInteger(
  name: string,
  value: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} 1-${maximum} aralığında bir tam sayı olmalıdır.`)
  }
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function decrementCount(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 0) - 1
  if (next > 0) counts.set(key, next)
  else counts.delete(key)
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0)
  }
  return data.byteLength
}

function isAllowedSignalDirection(
  role: ClientRole,
  payload: SignalingPayload,
): boolean {
  const signal = 'channel' in payload ? payload.signal : payload
  if (signal.kind === 'ice-candidate') return true
  return role === 'host'
    ? signal.description.type === 'offer'
    : signal.description.type === 'answer'
}

function createNegotiationState(): NegotiationState {
  return { answerReceived: false, seenIds: new Set() }
}

function acceptNegotiationSignal(
  session: Session,
  role: ClientRole,
  payload: SignalingPayload,
): NegotiationSignalDisposition {
  const lane: NegotiationLane = 'channel' in payload ? 'native-video' : 'peer'
  const signal = 'channel' in payload ? payload.signal : payload
  const state = session.negotiations[lane]

  if (signal.kind === 'ice-candidate') {
    return state.currentId === signal.negotiationId ? 'accepted' : 'stale'
  }

  if (signal.description.type === 'offer') {
    if (role !== 'host' || state.seenIds.has(signal.negotiationId)) {
      return 'stale'
    }
    if (state.seenIds.size >= MAX_NEGOTIATIONS_PER_LANE) {
      return 'exhausted'
    }
    state.seenIds.add(signal.negotiationId)
    state.currentId = signal.negotiationId
    state.answerReceived = false
    return 'accepted'
  }

  if (
    role !== 'guest' ||
    state.currentId !== signal.negotiationId ||
    state.answerReceived
  ) return 'stale'
  state.answerReceived = true
  return 'accepted'
}

function hashResumeToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function generateUniqueCode(sessions: Map<string, Session>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
    if (!sessions.has(code)) return code
  }
  throw new Error('Benzersiz bağlantı kodu üretilemedi.')
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
  }
}

function sendError(
  socket: WebSocket,
  code: Exclude<
    Extract<ServerMessage, { type: 'error' }>['code'],
    'rate_limited' | 'capacity_exceeded'
  >,
  message: string,
): void {
  send(socket, { type: 'error', code, message })
}

function loadAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>()
  for (const origin of origins) {
    const normalized = normalizeOrigin(origin)
    if (!normalized) {
      throw new Error(`Geçersiz signaling origin yapılandırması: ${origin}`)
    }
    result.add(normalized)
  }
  return result
}

function isAllowedWebSocketOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = normalizeOrigin(originHeader)
  if (!origin) return false
  if (allowedOrigins.has(origin)) return true
  if (!hostHeader) return false

  try {
    return new URL(origin).host.toLowerCase() === hostHeader.trim().toLowerCase()
  } catch {
    return false
  }
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

function hasSupportedSubprotocol(
  header: string | string[] | undefined,
): boolean {
  if (typeof header !== 'string') return false
  return header
    .split(',')
    .map((protocol) => protocol.trim())
    .includes(SIGNALING_SUBPROTOCOL)
}

function resolveClientIp(
  remoteAddress: string | undefined,
  cloudflareConnectingIp: string | string[] | undefined,
  trustCloudflareConnectingIp: boolean,
): string {
  const remoteIp = normalizeIp(remoteAddress) ?? 'unknown'
  if (!trustCloudflareConnectingIp || typeof cloudflareConnectingIp !== 'string') {
    return remoteIp
  }
  return normalizeIp(cloudflareConnectingIp) ?? remoteIp
}

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined
  const candidate = value.trim()
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(candidate)?.[1]
  if (mappedIpv4 && isIP(mappedIpv4) === 4) return mappedIpv4
  return isIP(candidate) === 0 ? undefined : candidate.toLowerCase()
}

function rejectWebSocketUpgrade(
  socket: Duplex,
  statusCode: number,
  statusText: string,
  retryAfterSeconds?: number,
): void {
  const retryAfter = retryAfterSeconds
    ? `Retry-After: ${retryAfterSeconds}\r\n`
    : ''
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Connection: close\r\n' +
      retryAfter +
      'Content-Length: 0\r\n\r\n',
  )
}
