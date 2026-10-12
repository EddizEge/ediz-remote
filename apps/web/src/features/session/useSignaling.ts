import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from 'react'
import type {
  ClientMessage,
  ControlAccessMode,
  IceConfiguration,
  ServerErrorOperation,
  ServerMessage,
  SignalingPayload,
} from '@ediz-remote/protocol'
import {
  SIGNALING_SUBPROTOCOL,
  iceConfigurationSchema,
  serverMessageSchema,
  signalingPayloadSchema,
} from '@ediz-remote/protocol'
import { getRuntimeConfiguration } from '../desktop/useDesktopBridge'
import {
  signalingIssueMessage,
  type SignalingIssueCode,
} from './userFacingIssue'
import { BoundedSignalQueue } from './signalingQueue'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'
export type SessionState = 'idle' | 'waiting' | 'joining' | 'active' | 'recovering'
export type SessionRole = 'host' | 'guest'
export type SignalingLane = 'peer' | 'native-video'
type SignalHandler = (payload: SignalingPayload) => void
type ServerErrorCode = Extract<ServerMessage, { type: 'error' }>['code']
type ServerMessageType = ServerMessage['type']

export type ServerErrorDisposition =
  | 'join-retry'
  | 'create-retry'
  | 'resume-retry'
  | 'active-retry'
  | 'fail-closed'

export type ServerMessageDisposition = 'allow' | 'ignore' | 'fail-closed'

const DEFAULT_ACTIVITY = 'Henüz aktif bir oturum yok.'

export function getServerErrorDisposition(
  code: ServerErrorCode,
  operation?: ServerErrorOperation,
): ServerErrorDisposition {
  if (code === 'capacity_exceeded') {
    return operation === 'create_session' ? 'create-retry' : 'fail-closed'
  }
  if (code === 'rate_limited') {
    if (operation === 'create_session') return 'create-retry'
    if (operation === 'join_session') return 'join-retry'
    if (operation === 'resume_session') return 'resume-retry'
    if (operation === 'refresh_ice' || operation === 'signal') {
      return 'active-retry'
    }
    return 'fail-closed'
  }
  if (code === 'invalid_code' || code === 'session_busy') {
    return 'join-retry'
  }
  if (code === 'peer_unavailable') return 'resume-retry'
  return 'fail-closed'
}

export function getServerMessageDisposition(
  type: ServerMessageType,
  state: SessionState,
  role: SessionRole | null,
): ServerMessageDisposition {
  switch (type) {
    case 'ready':
    case 'pong':
    case 'error':
      return 'allow'
    case 'session_created':
      return state === 'idle' && (role === null || role === 'host')
        ? 'allow'
        : 'ignore'
    case 'join_pending':
      return state === 'joining' && role === 'guest'
        ? 'allow'
        : 'ignore'
    case 'incoming_request':
      return state === 'waiting' && role === 'host' ? 'allow' : 'ignore'
    case 'session_approved':
    case 'request_rejected':
      return state === 'joining' && role === 'guest' ? 'allow' : 'ignore'
    case 'peer_joined':
      return state === 'waiting' && role === 'host' ? 'allow' : 'ignore'
    case 'session_resumed':
      return state === 'recovering' && role !== null ? 'allow' : 'ignore'
    case 'peer_suspended':
      return state === 'active' && role !== null ? 'allow' : 'ignore'
    case 'peer_resumed':
      return state === 'recovering' && role !== null ? 'allow' : 'ignore'
    case 'ice_configuration':
    case 'signal':
      return state === 'active' && role !== null ? 'allow' : 'ignore'
    case 'peer_left':
      return (state === 'active' || state === 'recovering') && role === 'host'
        ? 'allow'
        : 'ignore'
    case 'session_ended':
      return state !== 'idle' ? 'allow' : 'ignore'
  }
}

export function getServerErrorMessageDisposition(
  code: ServerErrorCode,
  state: SessionState,
  role: SessionRole | null,
  operation?: ServerErrorOperation,
): ServerMessageDisposition {
  const errorDisposition = getServerErrorDisposition(code, operation)
  if (errorDisposition === 'fail-closed') return 'allow'
  if (errorDisposition === 'join-retry') {
    return state === 'joining' && role === 'guest' ? 'allow' : 'ignore'
  }
  if (errorDisposition === 'create-retry') {
    return state === 'idle' && (role === null || role === 'host')
      ? 'allow'
      : 'ignore'
  }
  if (errorDisposition === 'active-retry') {
    return state === 'active' && role !== null ? 'allow' : 'ignore'
  }
  const retryableState =
    code === 'peer_unavailable'
      ? state === 'active' || state === 'recovering'
      : state === 'recovering'
  return retryableState && role !== null ? 'allow' : 'ignore'
}

export function useSignaling() {
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const rateLimitRetryTimerRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const signalHandlersRef = useRef<Record<SignalingLane, Set<SignalHandler>>>({
    peer: new Set(),
    'native-video': new Set(),
  })
  const pendingSignalsRef = useRef<Record<SignalingLane, BoundedSignalQueue<SignalingPayload>>>({
    peer: new BoundedSignalQueue(),
    'native-video': new BoundedSignalQueue(),
  })
  const resumeTokenRef = useRef<string | null>(null)
  const reconnectGraceSecondsRef = useRef(30)
  const lastIceRefreshAtRef = useRef(0)
  const manualReconnectRequiredRef = useRef(false)
  const sessionMessagesBlockedRef = useRef(false)
  const pendingSessionRequestRef = useRef<'create' | 'join' | null>(null)
  const controlRevokedForSessionRef = useRef(false)
  const sessionStateRef = useRef<SessionState>('idle')
  const sessionRoleRef = useRef<SessionRole | null>(null)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('connecting')
  const [sessionState, setSessionStateValue] = useState<SessionState>('idle')
  const [sessionRole, setSessionRoleValue] = useState<SessionRole | null>(null)
  const [sessionCode, setSessionCode] = useState<string | null>(null)
  const [incomingRequest, setIncomingRequest] = useState<string | null>(null)
  const [accessMode, setAccessMode] = useState<ControlAccessMode | null>(null)
  const [iceConfiguration, setIceConfiguration] =
    useState<IceConfiguration | null>(null)
  // Bumped only when every negotiation lane must rebuild with the new
  // configuration (approval and resume). A bare `ice_configuration` answers
  // one lane's own `refresh_ice` and leaves this version unchanged.
  const [iceResetVersion, setIceResetVersion] = useState(0)
  const [activity, setActivity] = useState(DEFAULT_ACTIVITY)
  const [errorCode, setErrorCode] = useState<SignalingIssueCode | null>(null)
  const error = signalingIssueMessage(errorCode)

  const setSessionState = useCallback(
    (next: SetStateAction<SessionState>) => {
      const resolved =
        typeof next === 'function' ? next(sessionStateRef.current) : next
      sessionStateRef.current = resolved
      setSessionStateValue(resolved)
    },
    [],
  )

  const setSessionRole = useCallback(
    (next: SetStateAction<SessionRole | null>) => {
      const resolved =
        typeof next === 'function' ? next(sessionRoleRef.current) : next
      sessionRoleRef.current = resolved
      setSessionRoleValue(resolved)
    },
    [],
  )

  const send = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }, [])

  const createSession = useCallback(() => {
    if (pendingSessionRequestRef.current === 'create') return
    resumeTokenRef.current = null
    sessionMessagesBlockedRef.current = false
    controlRevokedForSessionRef.current = false
    setErrorCode(null)
    setIncomingRequest(null)
    if (send({ type: 'create_session' })) {
      pendingSessionRequestRef.current = 'create'
      setSessionState('idle')
      setSessionRole('host')
      setActivity(DEFAULT_ACTIVITY)
    } else {
      sessionMessagesBlockedRef.current = true
      setErrorCode('invalid_server_response')
    }
  }, [send, setSessionRole, setSessionState])

  useEffect(() => {
    let disposed = false

    const connect = () => {
      if (disposed) return
      setConnectionStatus('connecting')
      const socket = new WebSocket(getWebSocketUrl(), SIGNALING_SUBPROTOCOL)
      socketRef.current = socket
      let protocolFailed = false
      let readyReceived = false

      const failClosedProtocol = (
        code: 'invalid_server_response' | 'invalid_ice_configuration',
      ) => {
        if (protocolFailed || disposed || socketRef.current !== socket) return
        protocolFailed = true
        manualReconnectRequiredRef.current = true
        sessionMessagesBlockedRef.current = true
        pendingSessionRequestRef.current = null
        clearPendingSignalQueues(pendingSignalsRef.current)
        resumeTokenRef.current = null
        setSessionCode(null)
        setSessionState('idle')
        setSessionRole(null)
        setIncomingRequest(null)
        setAccessMode(null)
        setIceConfiguration(null)
        setActivity('Güvenli bağlantı durduruldu. Yeniden bağlanmanız gerekiyor.')
        setErrorCode(code)
        setConnectionStatus('disconnected')
        if (socket.readyState < WebSocket.CLOSING) socket.close(1002)
      }

      const failClosedSession = (code: ServerErrorCode) => {
        sessionMessagesBlockedRef.current = true
        pendingSessionRequestRef.current = null
        clearPendingSignalQueues(pendingSignalsRef.current)
        resumeTokenRef.current = null
        setSessionCode(null)
        setSessionState('idle')
        setSessionRole('host')
        setIncomingRequest(null)
        setAccessMode(null)
        setIceConfiguration(null)
        setActivity('Eski erişim kapatıldı. Yeni bağlantı koduyla devam edin.')
        setErrorCode(code)
        send({ type: 'leave_session' })
      }

      socket.addEventListener('open', () => {
        if (disposed || protocolFailed || socketRef.current !== socket) return
        reconnectAttemptRef.current = 0
        setConnectionStatus('connected')
        if (!sessionMessagesBlockedRef.current) setErrorCode(null)
      })

      socket.addEventListener('message', (event) => {
        if (disposed || protocolFailed || socketRef.current !== socket) return
        let value: unknown
        try {
          value = JSON.parse(String(event.data))
        } catch {
          failClosedProtocol('invalid_server_response')
          return
        }
        const parsedMessage = serverMessageSchema.safeParse(value)
        if (!parsedMessage.success) {
          failClosedProtocol('invalid_server_response')
          return
        }
        const message = parsedMessage.data

        if (message.type === 'ready') {
          if (readyReceived) {
            failClosedProtocol('invalid_server_response')
            return
          }
          readyReceived = true
        } else if (!readyReceived) {
          failClosedProtocol('invalid_server_response')
          return
        }

        if (
          sessionMessagesBlockedRef.current &&
          message.type !== 'ready' &&
          message.type !== 'pong'
        ) {
          return
        }

        if (
          message.type === 'error' &&
          getServerErrorMessageDisposition(
            message.code,
            sessionStateRef.current,
            sessionRoleRef.current,
            'operation' in message ? message.operation : undefined,
          ) === 'ignore'
        ) {
          return
        }

        const disposition = getServerMessageDisposition(
          message.type,
          sessionStateRef.current,
          sessionRoleRef.current,
        )
        if (disposition === 'ignore') return
        if (disposition === 'fail-closed') {
          failClosedProtocol('invalid_server_response')
          return
        }

        switch (message.type) {
          case 'ready':
            if (sessionMessagesBlockedRef.current) break
            if (resumeTokenRef.current) {
              send({
                type: 'resume_session',
                token: resumeTokenRef.current,
              })
            } else {
              if (send({ type: 'create_session' })) {
                pendingSessionRequestRef.current = 'create'
              }
            }
            break
          case 'session_created':
            clearPendingSignalQueues(pendingSignalsRef.current)
            pendingSessionRequestRef.current = null
            controlRevokedForSessionRef.current = false
            setErrorCode(null)
            setSessionCode(message.code)
            setSessionState('waiting')
            setSessionRole('host')
            setAccessMode(null)
            setIceConfiguration(null)
            setActivity(DEFAULT_ACTIVITY)
            break
          case 'join_pending':
            clearPendingSignalQueues(pendingSignalsRef.current)
            pendingSessionRequestRef.current = null
            setIceConfiguration(null)
            setSessionCode(null)
            setSessionState('joining')
            setSessionRole('guest')
            setActivity('Karşı cihazın onayı bekleniyor.')
            break
          case 'incoming_request':
            setIncomingRequest(message.requestId)
            setActivity('Yeni bir bağlantı isteği geldi.')
            break
          case 'session_approved':
            {
              const parsed = iceConfigurationSchema.safeParse(
                message.iceConfiguration,
              )
              if (!parsed.success) {
                failClosedProtocol('invalid_ice_configuration')
                break
              }
              setIceConfiguration(parsed.data)
              setIceResetVersion((current) => current + 1)
            }
            setSessionRole('guest')
            controlRevokedForSessionRef.current = false
            resumeTokenRef.current = message.resumeToken
            reconnectGraceSecondsRef.current = message.reconnectGraceSeconds
            setAccessMode(message.accessMode)
            setIncomingRequest(null)
            setSessionState('active')
            setActivity('WebRTC bağlantısı kuruluyor.')
            break
          case 'peer_joined':
            {
              const parsed = iceConfigurationSchema.safeParse(
                message.iceConfiguration,
              )
              if (!parsed.success) {
                failClosedProtocol('invalid_ice_configuration')
                break
              }
              setIceConfiguration(parsed.data)
              setIceResetVersion((current) => current + 1)
            }
            setSessionRole('host')
            controlRevokedForSessionRef.current = false
            resumeTokenRef.current = message.resumeToken
            reconnectGraceSecondsRef.current = message.reconnectGraceSeconds
            setAccessMode(message.accessMode)
            setIncomingRequest(null)
            setSessionState('active')
            setActivity('WebRTC bağlantısı kuruluyor.')
            break
          case 'session_resumed':
            {
              const parsed = iceConfigurationSchema.safeParse(
                message.iceConfiguration,
              )
              if (!parsed.success) {
                failClosedProtocol('invalid_ice_configuration')
                break
              }
              setIceConfiguration(parsed.data)
              setIceResetVersion((current) => current + 1)
            }
            resumeTokenRef.current = message.resumeToken
            reconnectGraceSecondsRef.current = message.reconnectGraceSeconds
            setSessionCode(message.code)
            setSessionRole(message.role)
            if (
              message.role === 'host' &&
              controlRevokedForSessionRef.current
            ) {
              setAccessMode('view')
              if (message.accessMode === 'control') {
                send({
                  type: 'revoke_control',
                  channel: 'control',
                  version: 1,
                })
              }
            } else {
              setAccessMode(message.accessMode)
            }
            setSessionState(message.peerConnected ? 'active' : 'recovering')
            setActivity(
              message.peerConnected
                ? 'Oturum kurtarıldı. WebRTC yeniden kuruluyor.'
                : 'Karşı cihazın yeniden bağlanması bekleniyor.',
            )
            setErrorCode(null)
            break
          case 'peer_suspended':
            clearPendingSignalQueues(pendingSignalsRef.current)
            setSessionState('recovering')
            setActivity(
              `Bağlantı kesildi. ${new Date(message.reconnectUntil).toLocaleTimeString('tr-TR')} saatine kadar yeniden bağlanma bekleniyor.`,
            )
            setErrorCode(null)
            break
          case 'peer_resumed':
            {
              const parsed = iceConfigurationSchema.safeParse(
                message.iceConfiguration,
              )
              if (!parsed.success) {
                failClosedProtocol('invalid_ice_configuration')
                break
              }
              setIceConfiguration(parsed.data)
              setIceResetVersion((current) => current + 1)
            }
            setSessionState('active')
            setActivity('Karşı cihaz geri döndü. WebRTC yeniden kuruluyor.')
            setErrorCode(null)
            break
          case 'ice_configuration':
            {
              const parsed = iceConfigurationSchema.safeParse(
                message.iceConfiguration,
              )
              if (!parsed.success) {
                failClosedProtocol('invalid_ice_configuration')
                break
              }
              setIceConfiguration(parsed.data)
              setActivity('ICE bağlantısı yeni kimlik bilgileriyle yenileniyor.')
            }
            break
          case 'request_rejected':
            sessionMessagesBlockedRef.current = true
            pendingSessionRequestRef.current = null
            clearPendingSignalQueues(pendingSignalsRef.current)
            resumeTokenRef.current = null
            setIceConfiguration(null)
            setSessionState('idle')
            setSessionRole('host')
            setActivity(DEFAULT_ACTIVITY)
            setErrorCode('request_rejected')
            break
          case 'peer_left':
            clearPendingSignalQueues(pendingSignalsRef.current)
            resumeTokenRef.current = null
            setIceConfiguration(null)
            setSessionState('idle')
            setSessionRole('host')
            setSessionCode(null)
            setAccessMode(null)
            setActivity('Karşı cihaz bağlantıyı kapattı.')
            if (send({ type: 'create_session' })) {
              pendingSessionRequestRef.current = 'create'
            }
            break
          case 'session_ended':
            sessionMessagesBlockedRef.current = true
            pendingSessionRequestRef.current = null
            clearPendingSignalQueues(pendingSignalsRef.current)
            resumeTokenRef.current = null
            setIceConfiguration(null)
            setSessionCode(null)
            setAccessMode(null)
            setSessionState('idle')
            setSessionRole('host')
            setIncomingRequest(null)
            setActivity('Oturum sona erdi. Yeni bağlantı kodu oluşturabilirsiniz.')
            setErrorCode('session_ended')
            break
          case 'error':
            {
              const operation =
                'operation' in message ? message.operation : undefined
              const retryAfterSeconds =
                'retryAfterSeconds' in message
                  ? message.retryAfterSeconds
                  : undefined
              const errorDisposition = getServerErrorDisposition(
                message.code,
                operation,
              )
              if (errorDisposition === 'fail-closed') {
                failClosedSession(message.code)
                break
              }
              if (errorDisposition === 'join-retry') {
                sessionMessagesBlockedRef.current = true
                pendingSessionRequestRef.current = null
                setSessionState('idle')
                setSessionRole(null)
                setActivity('Bağlantı kodunu kontrol edip tekrar deneyin.')
              } else if (errorDisposition === 'create-retry') {
                sessionMessagesBlockedRef.current = false
                pendingSessionRequestRef.current = null
                setSessionState('idle')
                setSessionRole('host')
                setActivity(
                  `Yeni bağlantı kodu geçici olarak sınırlandı. ${retryAfterSeconds ?? 5} saniye sonra yeniden deneyin.`,
                )
              } else if (errorDisposition === 'resume-retry') {
                if (message.code === 'peer_unavailable') {
                  clearPendingSignalQueues(pendingSignalsRef.current)
                  setIceConfiguration(null)
                  setActivity(
                    'Karşı cihaz hazır olduğunda bağlantıyı yeniden kurun.',
                  )
                } else {
                  setActivity(
                    `Oturum kurtarma geçici olarak sınırlandı. ${retryAfterSeconds ?? 1} saniye sonra otomatik yeniden denenecek.`,
                  )
                  if (rateLimitRetryTimerRef.current !== null) {
                    window.clearTimeout(rateLimitRetryTimerRef.current)
                  }
                  rateLimitRetryTimerRef.current = window.setTimeout(() => {
                    rateLimitRetryTimerRef.current = null
                    if (
                      disposed ||
                      socketRef.current !== socket ||
                      sessionStateRef.current !== 'recovering' ||
                      !resumeTokenRef.current
                    ) {
                      return
                    }
                    socketRef.current = null
                    socket.close()
                    reconnectAttemptRef.current = 0
                    setErrorCode(null)
                    connect()
                  }, (retryAfterSeconds ?? 1) * 1_000)
                }
                setSessionState('recovering')
              } else {
                setActivity(
                  `Güvenli bağlantı trafiği geçici olarak sınırlandı. ${retryAfterSeconds ?? 1} saniye sonra otomatik yenilenecek.`,
                )
                if (rateLimitRetryTimerRef.current !== null) {
                  window.clearTimeout(rateLimitRetryTimerRef.current)
                }
                rateLimitRetryTimerRef.current = window.setTimeout(() => {
                  rateLimitRetryTimerRef.current = null
                  if (
                    disposed ||
                    socketRef.current !== socket ||
                    sessionStateRef.current !== 'active' ||
                    !resumeTokenRef.current
                  ) {
                    return
                  }
                  setErrorCode(null)
                  if (
                    operation === 'signal' &&
                    sessionRoleRef.current === 'guest'
                  ) {
                    setSessionState('recovering')
                    setActivity(
                      'Güvenli bağlantı yeni bir soket üzerinden kurtarılıyor.',
                    )
                    socketRef.current = null
                    socket.close()
                    reconnectAttemptRef.current = 0
                    connect()
                    return
                  }
                  setActivity('Güvenli bağlantı yeniden kuruluyor.')
                  if (!send({ type: 'refresh_ice' })) {
                    socketRef.current = null
                    socket.close()
                    reconnectAttemptRef.current = 0
                    connect()
                  }
                }, (retryAfterSeconds ?? 1) * 1_000)
              }
              setErrorCode(message.code)
            }
            break
          case 'signal':
            {
              const lane = getSignalingLane(message.payload)
              const handlers = signalHandlersRef.current[lane]
              if (handlers.size === 0) {
                if (!pendingSignalsRef.current[lane].tryEnqueue(message.payload)) {
                  clearPendingSignalQueues(pendingSignalsRef.current)
                  failClosedProtocol('invalid_server_response')
                }
              } else {
                for (const handler of handlers) handler(message.payload)
              }
            }
            break
          case 'pong':
            break
        }
      })

      socket.addEventListener('close', () => {
        if (socketRef.current !== socket) return
        socketRef.current = null
        if (disposed) return
        setConnectionStatus('disconnected')
        if (manualReconnectRequiredRef.current) {
          setSessionState('idle')
          setSessionRole(null)
          setSessionCode(null)
          setAccessMode(null)
          setIceConfiguration(null)
          setIncomingRequest(null)
          return
        }
        if (resumeTokenRef.current) {
          setSessionState('recovering')
          setActivity(
            `Sinyalleşme bağlantısı kesildi. ${reconnectGraceSecondsRef.current} saniye içinde yeniden bağlanılıyor.`,
          )
        } else {
          setSessionState('idle')
          setSessionRole(null)
          setSessionCode(null)
          setAccessMode(null)
          setIceConfiguration(null)
        }
        setIncomingRequest(null)
        const delay = Math.min(1_000 * 2 ** reconnectAttemptRef.current, 10_000)
        reconnectAttemptRef.current += 1
        reconnectTimerRef.current = window.setTimeout(connect, delay)
      })

      socket.addEventListener('error', () => {
        if (disposed || socketRef.current !== socket) return
        socket.close()
      })
    }

    const reconnectAfterNetworkRestore = () => {
      if (disposed || !resumeTokenRef.current) return
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      const staleSocket = socketRef.current
      socketRef.current = null
      staleSocket?.close()
      reconnectAttemptRef.current = 0
      connect()
    }

    window.addEventListener('online', reconnectAfterNetworkRestore)
    connect()
    return () => {
      disposed = true
      window.removeEventListener('online', reconnectAfterNetworkRestore)
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
      }
      if (rateLimitRetryTimerRef.current !== null) {
        window.clearTimeout(rateLimitRetryTimerRef.current)
        rateLimitRetryTimerRef.current = null
      }
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [connectionAttempt, send, setSessionRole, setSessionState])

  const joinSession = useCallback(
    (code: string) => {
      if (pendingSessionRequestRef.current === 'join') return
      sessionMessagesBlockedRef.current = false
      controlRevokedForSessionRef.current = false
      setErrorCode(null)
      if (send({ type: 'join_session', code })) {
        pendingSessionRequestRef.current = 'join'
        setSessionCode(null)
        setSessionState('joining')
        setSessionRole('guest')
        setActivity('Destek alan cihazın onayı bekleniyor.')
      } else {
        sessionMessagesBlockedRef.current = true
        setErrorCode('invalid_server_response')
      }
    },
    [send, setSessionRole, setSessionState],
  )

  const decideRequest = useCallback(
    (approved: boolean, requestedAccessMode?: ControlAccessMode) => {
      if (!incomingRequest) return
      const sent = send({
        type: 'request_decision',
        requestId: incomingRequest,
        approved,
        ...(approved ? { accessMode: requestedAccessMode ?? 'view' } : {}),
      })
      if (!sent) {
        setErrorCode('invalid_server_response')
        return
      }
      setIncomingRequest(null)
      setActivity(approved ? 'Güvenli oturum kuruluyor.' : DEFAULT_ACTIVITY)
    },
    [incomingRequest, send],
  )

  const sendSignal = useCallback(
    (payload: unknown) => {
      const result = signalingPayloadSchema.safeParse(payload)
      return result.success && send({ type: 'signal', payload: result.data })
    },
    [send],
  )

  const subscribeToSignals = useCallback((
    lane: SignalingLane,
    handler: SignalHandler,
  ) => {
    signalHandlersRef.current[lane].add(handler)
    const queuedSignals = pendingSignalsRef.current[lane].drain()
    for (const signal of queuedSignals) handler(signal)
    return () => signalHandlersRef.current[lane].delete(handler)
  }, [])

  const leaveSession = useCallback(() => {
    if (rateLimitRetryTimerRef.current !== null) {
      window.clearTimeout(rateLimitRetryTimerRef.current)
      rateLimitRetryTimerRef.current = null
    }
    clearPendingSignalQueues(pendingSignalsRef.current)
    pendingSessionRequestRef.current = null
    resumeTokenRef.current = null
    controlRevokedForSessionRef.current = false
    send({ type: 'leave_session' })
    setSessionCode(null)
    setSessionState('idle')
    setSessionRole('host')
    setIncomingRequest(null)
    setAccessMode(null)
    setIceConfiguration(null)
    setErrorCode(null)
    setActivity('Oturum kapatıldı. Yeni bağlantı kodu oluşturuluyor.')
    if (send({ type: 'create_session' })) {
      pendingSessionRequestRef.current = 'create'
    }
  }, [send, setSessionRole, setSessionState])

  const revokeControl = useCallback(() => {
    controlRevokedForSessionRef.current = true
    send({
      type: 'revoke_control',
      channel: 'control',
      version: 1,
    })
    setAccessMode((current) => (current === 'control' ? 'view' : current))
  }, [send])

  const clearError = useCallback(() => setErrorCode(null), [])

  const retryConnection = useCallback(() => {
    if (rateLimitRetryTimerRef.current !== null) {
      window.clearTimeout(rateLimitRetryTimerRef.current)
      rateLimitRetryTimerRef.current = null
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const canResume = resumeTokenRef.current !== null
    manualReconnectRequiredRef.current = false
    sessionMessagesBlockedRef.current = false
    reconnectAttemptRef.current = 0
    setErrorCode(null)
    setIncomingRequest(null)
    if (!canResume) setAccessMode(null)
    setIceConfiguration(null)
    setSessionState(canResume ? 'recovering' : 'idle')
    setConnectionAttempt((current) => current + 1)
  }, [setSessionState])

  const requestIceRefresh = useCallback(
    () => {
      const requestedAt = Date.now()
      if (requestedAt - lastIceRefreshAtRef.current < 1_000) return false
      const sent = send({ type: 'refresh_ice' })
      if (sent) lastIceRefreshAtRef.current = requestedAt
      return sent
    },
    [send],
  )

  return {
    connectionStatus,
    sessionState,
    sessionRole,
    sessionCode,
    incomingRequest,
    accessMode,
    iceConfiguration,
    iceResetVersion,
    activity,
    error,
    errorCode,
    createSession,
    joinSession,
    decideRequest,
    sendSignal,
    subscribeToSignals,
    requestIceRefresh,
    revokeControl,
    clearError,
    retryConnection,
    leaveSession,
  }
}

function getWebSocketUrl(): string {
  const runtimeUrl = getRuntimeConfiguration().signalingUrl
  if (runtimeUrl) return runtimeUrl
  const configured = import.meta.env.VITE_SIGNALING_URL as string | undefined
  if (configured) return configured
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

function getSignalingLane(payload: SignalingPayload): SignalingLane {
  return 'channel' in payload ? 'native-video' : 'peer'
}

function clearPendingSignalQueues(
  queues: Record<SignalingLane, BoundedSignalQueue<SignalingPayload>>,
): void {
  queues.peer.clear()
  queues['native-video'].clear()
}
