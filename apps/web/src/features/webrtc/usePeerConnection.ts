import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ControlInputEvent,
  IceConfiguration,
} from '@ediz-remote/protocol'
import {
  parseDesktopCursorState,
  postDesktopMessage,
  subscribeToDesktopMessages,
} from '../desktop/useDesktopBridge'
import type { SessionRole, SessionState } from '../session/useSignaling'
import {
  detectConnectionPath,
  hasExpectedDataChannelTransport,
  isInboundDataChannelMessageAllowed,
  isSessionDataChannelMessage,
  parseDataChannelMessage,
  parsePeerSignal,
  type ConnectionPath,
  type DataChannelKind,
  type DataChannelMessage,
  type MediaState,
  type QualityProfile,
  type RemoteCursorState,
  type SessionDisplay,
} from './peerProtocol'
import { ControlEventRateLimiter } from './remoteControl'
import {
  PendingIceCandidateQueue,
  bindLocalIceGeneration,
  resolveLocalCandidateNegotiationId,
  type LocalIceGenerationBinding,
} from './negotiation'
import {
  hasTurnServer,
  resolveIceServers,
  resolveIceTransportPolicy,
} from './iceConfiguration'

export type PeerConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'

export interface PeerConnectionState {
  status: PeerConnectionStatus
  path: ConnectionPath
  latencyMs: number | null
  remoteStream: MediaStream | null
  remoteScreenActive: boolean
  remoteMediaState: MediaState
  controlGranted: boolean
  remoteDisplays: SessionDisplay[]
  remoteSelectedDisplayId: string | null
  remoteQualityProfile: QualityProfile
  error: string | null
}

export interface PeerConnectionController extends PeerConnectionState {
  retry: () => void
  sendControlEvent: (event: ControlInputEvent) => boolean
  selectRemoteDisplay: (displayId: string) => boolean
  selectQualityProfile: (profile: QualityProfile) => boolean
  subscribeToRemoteCursor: (
    listener: (state: RemoteCursorState) => void,
  ) => () => void
}

interface UsePeerConnectionOptions {
  enabled: boolean
  sessionState: SessionState
  role: SessionRole | null
  localStream: MediaStream | null
  controlAllowed: boolean
  iceConfiguration: IceConfiguration | null
  sendSignal: (payload: unknown) => boolean
  subscribeToSignals: (
    lane: 'peer' | 'native-video',
    handler: (payload: unknown) => void,
  ) => () => boolean
  requestIceRefresh: () => boolean
  localDisplays?: SessionDisplay[]
  selectedDisplayId?: string | null
  onDisplaySelect?: (displayId: string) => void
  localQualityProfile?: QualityProfile
  onQualityProfileSelect?: (profile: QualityProfile) => void
  localMediaState?: MediaState
}

const IDLE_STATE: PeerConnectionState = {
  status: 'idle',
  path: 'unknown',
  latencyMs: null,
  remoteStream: null,
  remoteScreenActive: false,
  remoteMediaState: 'stopped',
  controlGranted: false,
  remoteDisplays: [],
  remoteSelectedDisplayId: null,
  remoteQualityProfile: 'auto',
  error: null,
}

interface PeerDiagnostics {
  role: SessionRole
  transportPolicy: RTCIceTransportPolicy
  localCandidates: Array<{ type: string; protocol: string }>
  remoteCandidates: Array<{ type: string; protocol: string }>
  iceGatheringState: RTCIceGatheringState
  iceConnectionState: RTCIceConnectionState
  connectionState: RTCPeerConnectionState
  dataChannels: Record<string, RTCDataChannelState>
}

const DIAGNOSTICS_ENABLED =
  import.meta.env.VITE_E2E_DIAGNOSTICS === 'true'

export class SequencedMessageGuard {
  private lastSequence = -1

  constructor(
    maximumEvents: number,
    windowMilliseconds: number,
  ) {
    this.rateLimiter = new ControlEventRateLimiter(
      maximumEvents,
      windowMilliseconds,
    )
  }

  private readonly rateLimiter: ControlEventRateLimiter

  accept(sequence: number, now: number): 'accepted' | 'replay' | 'rate-limited' {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence <= this.lastSequence
    ) {
      return 'replay'
    }
    if (!this.rateLimiter.tryConsume(now)) return 'rate-limited'
    this.lastSequence = sequence
    return 'accepted'
  }

  tryAccept(sequence: number, now: number): boolean {
    return this.accept(sequence, now) === 'accepted'
  }
}

export class MediaStateMessageGuard extends SequencedMessageGuard {
  constructor() {
    super(8, 1_000)
  }
}

export class PeerProtocolFatalLatch {
  private value = false

  get tripped(): boolean {
    return this.value
  }

  trip(): boolean {
    if (this.value) return false
    this.value = true
    return true
  }

  reset(): void {
    this.value = false
  }
}

export class SessionSelectionRateGuard {
  private readonly displayLimiter = new ControlEventRateLimiter(4, 1_000)
  private readonly qualityLimiter = new ControlEventRateLimiter(4, 1_000)

  tryConsume(
    type: 'display.select' | 'quality.select',
    now: number,
  ): boolean {
    return (type === 'display.select' ? this.displayLimiter : this.qualityLimiter)
      .tryConsume(now)
  }
}

function setPeerDiagnostics(value: PeerDiagnostics): void {
  if (!DIAGNOSTICS_ENABLED) return
  ;(window as Window & { __edizRemotePeerDiagnostics?: PeerDiagnostics })
    .__edizRemotePeerDiagnostics = value
}

function updatePeerDiagnostics(
  update: (current: PeerDiagnostics) => void,
): void {
  if (!DIAGNOSTICS_ENABLED) return
  const target = window as Window & {
    __edizRemotePeerDiagnostics?: PeerDiagnostics
  }
  if (target.__edizRemotePeerDiagnostics) {
    update(target.__edizRemotePeerDiagnostics)
  }
}

function candidateSummary(candidate: string): {
  type: string
  protocol: string
} {
  const fields = candidate.trim().split(/\s+/)
  const typeIndex = fields.findIndex((field) => field === 'typ')
  return {
    protocol: fields[2]?.toLowerCase() ?? 'unknown',
    type: typeIndex >= 0 ? (fields[typeIndex + 1] ?? 'unknown') : 'unknown',
  }
}

export function usePeerConnection({
  enabled,
  sessionState,
  role,
  localStream,
  controlAllowed,
  iceConfiguration,
  sendSignal,
  subscribeToSignals,
  requestIceRefresh,
  localDisplays = [],
  selectedDisplayId = null,
  onDisplaySelect,
  localQualityProfile = 'auto',
  onQualityProfileSelect,
  localMediaState = 'stopped',
}: UsePeerConnectionOptions): PeerConnectionController {
  const [state, setState] = useState<PeerConnectionState>(IDLE_STATE)
  const [retryVersion, setRetryVersion] = useState(0)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const dataChannelRef = useRef<RTCDataChannel | null>(null)
  const pointerChannelRef = useRef<RTCDataChannel | null>(null)
  const localStreamRef = useRef(localStream)
  const controlAllowedRef = useRef(controlAllowed)
  const controlGrantedRef = useRef(false)
  const reliableControlSequenceRef = useRef(0)
  const pointerControlSequenceRef = useRef(0)
  const localSessionSequenceRef = useRef(0)
  const transportConnectedRef = useRef(false)
  const nativeControlSessionIdRef = useRef<string | null>(null)
  const renegotiateRef = useRef<(() => Promise<void>) | null>(null)
  const iceRestartAttemptsRef = useRef(0)
  const protocolFatalLatchRef = useRef<PeerProtocolFatalLatch | null>(null)
  const localDisplaysRef = useRef(localDisplays)
  const selectedDisplayIdRef = useRef(selectedDisplayId)
  const onDisplaySelectRef = useRef(onDisplaySelect)
  const localQualityProfileRef = useRef(localQualityProfile)
  const onQualityProfileSelectRef = useRef(onQualityProfileSelect)
  const localMediaStateRef = useRef(localMediaState)
  const remoteCursorListenersRef = useRef(
    new Set<(state: RemoteCursorState) => void>(),
  )
  if (protocolFatalLatchRef.current === null) {
    protocolFatalLatchRef.current = new PeerProtocolFatalLatch()
  }
  localStreamRef.current = localStream
  controlAllowedRef.current = controlAllowed
  localDisplaysRef.current = localDisplays
  selectedDisplayIdRef.current = selectedDisplayId
  onDisplaySelectRef.current = onDisplaySelect
  localQualityProfileRef.current = localQualityProfile
  onQualityProfileSelectRef.current = onQualityProfileSelect
  localMediaStateRef.current = localMediaState

  const retry = useCallback(() => {
    protocolFatalLatchRef.current?.reset()
    iceRestartAttemptsRef.current = 0
    setRetryVersion((current) => current + 1)
  }, [])

  const subscribeToRemoteCursor = useCallback(
    (listener: (state: RemoteCursorState) => void) => {
      remoteCursorListenersRef.current.add(listener)
      return () => remoteCursorListenersRef.current.delete(listener)
    },
    [],
  )

  const takeLocalSessionSequence = useCallback((): number | null => {
    const sequence = localSessionSequenceRef.current
    if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER) {
      return null
    }
    localSessionSequenceRef.current = sequence + 1
    return sequence
  }, [])

  const sendControlEvent = useCallback(
    (event: ControlInputEvent): boolean => {
      if (
        role !== 'guest' ||
        !controlGrantedRef.current ||
        !transportConnectedRef.current
      ) return false
      const preferredChannel =
        event.kind === 'pointer.move'
          ? pointerChannelRef.current
          : dataChannelRef.current
      const fallbackChannel = dataChannelRef.current
      const channel =
        preferredChannel?.readyState === 'open'
          ? preferredChannel
          : fallbackChannel?.readyState === 'open'
            ? fallbackChannel
            : null
      if (!channel) return false
      const sequenceRef =
        event.kind === 'pointer.move'
          ? pointerControlSequenceRef
          : reliableControlSequenceRef

      channel.send(
        JSON.stringify({
          channel: 'control',
          version: 1,
          type: 'control.event',
          sequence: sequenceRef.current,
          event,
        }),
      )
      sequenceRef.current += 1
      return true
    },
    [role],
  )

  const selectRemoteDisplay = useCallback(
    (displayId: string): boolean => {
      if (
        role !== 'guest' ||
        !state.remoteDisplays.some((display) => display.id === displayId)
      ) {
        return false
      }
      const channel = dataChannelRef.current
      if (
        channel?.readyState !== 'open' ||
        !transportConnectedRef.current
      ) return false
      const sequence = takeLocalSessionSequence()
      if (sequence === null) return false
      channel.send(JSON.stringify({
        channel: 'session',
        version: 2,
        type: 'display.select',
        sequence,
        displayId,
      } satisfies DataChannelMessage))
      setState((current) => ({
        ...current,
        remoteSelectedDisplayId: displayId,
      }))
      return true
    },
    [role, state.remoteDisplays, takeLocalSessionSequence],
  )

  const selectQualityProfile = useCallback(
    (profile: QualityProfile): boolean => {
      if (role !== 'guest') return false
      const channel = dataChannelRef.current
      if (
        channel?.readyState !== 'open' ||
        !transportConnectedRef.current
      ) return false
      const sequence = takeLocalSessionSequence()
      if (sequence === null) return false
      channel.send(JSON.stringify({
        channel: 'session',
        version: 2,
        type: 'quality.select',
        sequence,
        profile,
      } satisfies DataChannelMessage))
      setState((current) => ({ ...current, remoteQualityProfile: profile }))
      return true
    },
    [role, takeLocalSessionSequence],
  )

  useEffect(() => {
    const persistentFatalLatch = protocolFatalLatchRef.current!
    const approvedSessionContinues =
      sessionState === 'active' || sessionState === 'recovering'
    if (!approvedSessionContinues) persistentFatalLatch.reset()
    if (!enabled || !role) {
      iceRestartAttemptsRef.current = 0
      localSessionSequenceRef.current = 0
      transportConnectedRef.current = false
      peerConnectionRef.current = null
      renegotiateRef.current = null
      setState(IDLE_STATE)
      return
    }
    if (persistentFatalLatch.tripped) {
      transportConnectedRef.current = false
      controlGrantedRef.current = false
      setState((current) => ({
        ...current,
        status: 'failed',
        controlGranted: false,
        error: current.error ?? 'Güvenli bağlantı kullanıcı yeniden denemesi bekliyor.',
      }))
      return
    }

    let disposed = false
    let makingOffer = false
    let reliableDataChannel: RTCDataChannel | null = null
    let pointerDataChannel: RTCDataChannel | null = null
    let pingTimer: number | null = null
    let iceRestartTimer: number | null = null
    let signalChain = Promise.resolve()
    let fatalFailureLatched = false
    let activeNegotiationId: string | null = null
    let activeLocalIceGeneration: LocalIceGenerationBinding | null = null
    let localDescriptionPublished = false
    const pendingRemoteCandidates = new PendingIceCandidateQueue()
    const pendingLocalCandidates = new PendingIceCandidateQueue()
    const pointerControlMessageGuard = new SequencedMessageGuard(240, 1_000)
    const reliableControlMessageGuard = new SequencedMessageGuard(120, 1_000)
    const sessionSelectionRateGuard = new SessionSelectionRateGuard()
    const sessionMessageGuard = new SequencedMessageGuard(128, 1_000)
    const pendingPings = new Map<string, number>()
    const nativeControlSessionId = crypto.randomUUID()
    if (role === 'host') {
      nativeControlSessionIdRef.current = nativeControlSessionId
      postDesktopMessage({
        type: 'desktop.control.set-enabled',
        channel: 'control',
        version: 1,
        sessionId: nativeControlSessionId,
        enabled: false,
      })
    }
    const inboundStream = new MediaStream()
    const peerConnection = new RTCPeerConnection({
      iceServers: resolveIceServers(iceConfiguration),
      bundlePolicy: 'max-bundle',
      iceTransportPolicy: resolveIceTransportPolicy(),
    })
    transportConnectedRef.current = false
    setPeerDiagnostics({
      role,
      transportPolicy: resolveIceTransportPolicy(),
      localCandidates: [],
      remoteCandidates: [],
      iceGatheringState: peerConnection.iceGatheringState,
      iceConnectionState: peerConnection.iceConnectionState,
      connectionState: peerConnection.connectionState,
      dataChannels: {},
    })
    peerConnectionRef.current = peerConnection
    if (role === 'host' && localStreamRef.current) {
      for (const track of localStreamRef.current.getVideoTracks()) {
        if (track.readyState === 'live') {
          peerConnection.addTrack(track, localStreamRef.current)
        }
      }
    }

    setState({
      status: 'connecting',
      path: 'unknown',
      latencyMs: null,
      remoteStream: null,
      remoteScreenActive: false,
      remoteMediaState: 'stopped',
      controlGranted: role === 'host' && controlAllowedRef.current,
      remoteDisplays: [],
      remoteSelectedDisplayId: null,
      remoteQualityProfile: 'auto',
      error: null,
    })

    const publishRemoteCursor = (cursor: RemoteCursorState) => {
      for (const listener of remoteCursorListenersRef.current) listener(cursor)
    }

    const disableControlTransport = (
      status: PeerConnectionStatus,
      error: string | null,
    ) => {
      transportConnectedRef.current = false
      controlGrantedRef.current = false
      if (role === 'host') {
        postDesktopMessage({
          type: 'desktop.control.set-enabled',
          channel: 'control',
          version: 1,
          sessionId: nativeControlSessionId,
          enabled: false,
        })
      }
      publishRemoteCursor({ sequence: 0, x: 0, y: 0, visible: false })
      setState((current) => ({
        ...current,
        status,
        controlGranted: false,
        error,
      }))
    }

    const closeCanonicalChannels = () => {
      if (pointerDataChannel?.readyState !== 'closed') pointerDataChannel?.close()
      if (reliableDataChannel?.readyState !== 'closed') reliableDataChannel?.close()
      pointerDataChannel = null
      reliableDataChannel = null
      pointerChannelRef.current = null
      dataChannelRef.current = null
    }

    const failClosed = (message: string) => {
      if (disposed || fatalFailureLatched) return
      fatalFailureLatched = true
      persistentFatalLatch.trip()
      if (pingTimer !== null) {
        window.clearInterval(pingTimer)
        pingTimer = null
      }
      if (iceRestartTimer !== null) {
        window.clearTimeout(iceRestartTimer)
        iceRestartTimer = null
      }
      pendingPings.clear()
      pendingLocalCandidates.clear()
      pendingRemoteCandidates.clear()
      disableControlTransport('failed', message)
      closeCanonicalChannels()
      peerConnection.close()
    }

    const fail = (_error: unknown) => {
      if (disposed || fatalFailureLatched) return
      setState((current) => ({
        ...current,
        status: 'failed',
        error: 'Cihazlar arasında güvenli bağlantı kurulamadı.',
      }))
    }

    const scheduleIceRestart = (initialDelay: number) => {
      if (disposed || fatalFailureLatched || iceRestartTimer !== null) return
      if (iceRestartAttemptsRef.current >= 3) {
        fail(
          new Error(
            hasTurnServer(iceConfiguration)
              ? 'ICE bağlantısı üç yenileme denemesinden sonra kurulamadı.'
              : 'ICE bağlantısı kurulamadı ve TURN relay yapılandırılmamış.',
          ),
        )
        return
      }
      const delay =
        initialDelay * 2 ** Math.min(iceRestartAttemptsRef.current, 2)
      setState((current) => ({
        ...current,
        status: 'connecting',
        error: `Bağlantı yenileniyor (${iceRestartAttemptsRef.current + 1}/3).`,
      }))
      iceRestartTimer = window.setTimeout(() => {
        iceRestartTimer = null
        iceRestartAttemptsRef.current += 1
        if (!requestIceRefresh()) {
          scheduleIceRestart(1_000)
        }
      }, delay)
    }

    const refreshConnectionPath = async () => {
      try {
        const path = await detectConnectionPath(peerConnection)
        if (!disposed && !fatalFailureLatched) {
          setState((current) => ({ ...current, path }))
        }
      } catch {
        // Aday istatistikleri bağlantının ilk anında henüz hazır olmayabilir.
      }
    }

    const sendDataMessage = (message: DataChannelMessage) => {
      if (fatalFailureLatched) return
      if (reliableDataChannel?.readyState === 'open') {
        reliableDataChannel.send(JSON.stringify(message))
      }
    }

    const unsubscribeDesktopCursor = role === 'host'
      ? subscribeToDesktopMessages((event) => {
          const message = parseDesktopCursorState(event.data)
          if (!message || disposed || fatalFailureLatched) return
          const sequence = takeLocalSessionSequence()
          if (sequence === null) {
            failClosed('Oturum mesaj sıra alanı tükendi.')
            return
          }
          sendDataMessage({
            channel: 'session',
            version: 2,
            type: 'cursor.state',
            sequence,
            x: message.payload.x,
            y: message.payload.y,
            visible: message.payload.visible,
          })
        })
      : () => undefined

    const sendPing = () => {
      if (
        fatalFailureLatched ||
        !transportConnectedRef.current ||
        reliableDataChannel?.readyState !== 'open'
      ) return
      if (pendingPings.size >= 8) {
        const oldest = pendingPings.keys().next().value
        if (oldest) pendingPings.delete(oldest)
      }
      const id = crypto.randomUUID()
      const sentAt = Date.now()
      pendingPings.set(id, sentAt)
      sendDataMessage({ type: 'ping', id, sentAt })
    }

    const sendScreenShareState = () => {
      if (role !== 'host') return
      const sequence = takeLocalSessionSequence()
      if (sequence === null) {
        failClosed('Oturum mesaj sıra alanı tükendi.')
        return
      }
      sendDataMessage({
        channel: 'session',
        version: 2,
        type: 'screen-share-state',
        sequence,
        active: Boolean(localStreamRef.current),
      })
    }

    const sendControlState = () => {
      if (
        role !== 'host' ||
        !transportConnectedRef.current ||
        reliableDataChannel?.readyState !== 'open'
      ) return
      sendDataMessage(
        controlAllowedRef.current
          ? {
              channel: 'control',
              version: 1,
              type: 'control.granted',
              capabilities: ['pointer', 'keyboard'],
            }
          : {
              channel: 'control',
              version: 1,
              type: 'control.revoked',
              reason: 'host',
            },
      )
    }

    const sendDisplayList = () => {
      if (role !== 'host') return
      const sequence = takeLocalSessionSequence()
      if (sequence === null) {
        failClosed('Oturum mesaj sıra alanı tükendi.')
        return
      }
      const displays = localDisplaysRef.current
      const selected = selectedDisplayIdRef.current
      sendDataMessage({
        channel: 'session',
        version: 2,
        type: 'display.list',
        sequence,
        displays,
        selectedDisplayId:
          selected && displays.some((display) => display.id === selected)
            ? selected
            : null,
      })
    }

    const sendQualityState = () => {
      if (role !== 'host') return
      const sequence = takeLocalSessionSequence()
      if (sequence === null) {
        failClosed('Oturum mesaj sıra alanı tükendi.')
        return
      }
      sendDataMessage({
        channel: 'session',
        version: 2,
        type: 'quality.state',
        sequence,
        profile: localQualityProfileRef.current,
      })
    }

    const sendMediaState = () => {
      if (role !== 'host') return
      const sequence = takeLocalSessionSequence()
      if (sequence === null) {
        failClosed('Oturum mesaj sıra alanı tükendi.')
        return
      }
      sendDataMessage({
        channel: 'session',
        version: 2,
        type: 'media.state',
        sequence,
        state: localMediaStateRef.current,
      })
    }

    const handleControlEvent = (
      message: Extract<DataChannelMessage, { type: 'control.event' }>,
      channelKind: DataChannelKind,
    ) => {
      if (
        role !== 'host' ||
        !controlAllowedRef.current ||
        !transportConnectedRef.current ||
        reliableDataChannel?.readyState !== 'open'
      ) return
      if (message.event.kind === 'pointer.move') {
        if (
          channelKind === 'reliable' &&
          pointerDataChannel?.readyState === 'open'
        ) return
        const decision = pointerControlMessageGuard.accept(message.sequence, Date.now())
        if (decision === 'rate-limited') {
          failClosed('Uzaktan kontrol veri hızı güvenli sınırı aştı.')
          return
        }
        if (decision !== 'accepted') return
      } else {
        if (channelKind !== 'reliable') return
        const decision = reliableControlMessageGuard.accept(message.sequence, Date.now())
        if (decision === 'rate-limited') {
          failClosed('Uzaktan kontrol veri hızı güvenli sınırı aştı.')
          return
        }
        if (decision !== 'accepted') return
      }
      const sessionId = nativeControlSessionIdRef.current
      if (!sessionId) return
      postDesktopMessage({
        type: 'desktop.control.event',
        channel: 'control',
        version: 1,
        sessionId,
        payload: message,
      })
    }

    const attachDataChannel = (
      channel: RTCDataChannel,
      channelKind: DataChannelKind,
    ) => {
      if (fatalFailureLatched) {
        channel.close()
        return
      }
      if (!hasExpectedDataChannelTransport(channel, channelKind)) {
        channel.close()
        return
      }
      const existing =
        channelKind === 'reliable' ? reliableDataChannel : pointerDataChannel
      if (existing && existing.readyState !== 'closed') {
        channel.close()
        return
      }
      if (channelKind === 'reliable') {
        reliableDataChannel = channel
        dataChannelRef.current = channel
      } else {
        pointerDataChannel = channel
        pointerChannelRef.current = channel
      }
      channel.binaryType = 'arraybuffer'
      const rawMessageRateLimiter = new ControlEventRateLimiter(
        channelKind === 'reliable' ? 256 : 300,
        1_000,
      )
      updatePeerDiagnostics((diagnostics) => {
        diagnostics.dataChannels[channel.label] = channel.readyState
      })

      channel.addEventListener('open', () => {
        if (disposed || fatalFailureLatched) {
          channel.close()
          return
        }
        updatePeerDiagnostics((diagnostics) => {
          diagnostics.dataChannels[channel.label] = channel.readyState
        })
        if (channelKind === 'reliable' && transportConnectedRef.current) {
          if (role === 'host') {
            controlGrantedRef.current = controlAllowedRef.current
          }
          setState((current) => ({
            ...current,
            status: 'connected',
            controlGranted:
              role === 'host' ? controlAllowedRef.current : current.controlGranted,
            error: null,
          }))
          void refreshConnectionPath()
          sendPing()
          if (role === 'host') {
            postDesktopMessage({
              type: 'desktop.control.set-enabled',
              channel: 'control',
              version: 1,
              sessionId: nativeControlSessionId,
              enabled: controlAllowedRef.current,
            })
            sendScreenShareState()
            sendControlState()
            sendDisplayList()
            sendQualityState()
            sendMediaState()
          }
        }
        if (channelKind === 'reliable' && pingTimer === null) {
          pingTimer = window.setInterval(sendPing, 2_000)
        }
      })

      channel.addEventListener('message', (event) => {
        if (disposed || fatalFailureLatched) return
        if (!rawMessageRateLimiter.tryConsume(Date.now())) {
          failClosed('WebRTC veri kanalı güvenli mesaj hızını aştı.')
          return
        }
        if (typeof event.data !== 'string') return
        const message = parseDataChannelMessage(event.data)
        if (!message) return
        if (
          !isInboundDataChannelMessageAllowed(
            message,
            channelKind,
            role,
            controlAllowedRef.current,
          )
        ) return
        if (isSessionDataChannelMessage(message)) {
          const decision = sessionMessageGuard.accept(message.sequence, Date.now())
          if (decision === 'rate-limited') {
            failClosed('Oturum veri hızı güvenli sınırı aştı.')
            return
          }
          if (decision !== 'accepted') return
        }

        if (message.type === 'ping') {
          sendDataMessage({ type: 'pong', id: message.id, sentAt: message.sentAt })
        } else if (message.type === 'pong' && !disposed) {
          const sentAt = pendingPings.get(message.id)
          if (sentAt === undefined || sentAt !== message.sentAt) return
          pendingPings.delete(message.id)
          setState((current) => ({
            ...current,
            latencyMs: Math.max(0, Date.now() - sentAt),
          }))
        } else if (message.type === 'screen-share-state' && !disposed) {
          setState((current) => ({
            ...current,
            remoteScreenActive: message.active,
            remoteStream: message.active ? current.remoteStream : null,
          }))
        } else if (message.type === 'control.granted' && role === 'guest' && !disposed) {
          controlGrantedRef.current = true
          setState((current) => ({ ...current, controlGranted: true }))
        } else if (message.type === 'control.revoked' && role === 'guest' && !disposed) {
          controlGrantedRef.current = false
          setState((current) => ({ ...current, controlGranted: false }))
        } else if (message.type === 'control.event') {
          handleControlEvent(message, channelKind)
        } else if (message.type === 'display.list' && role === 'guest' && !disposed) {
          setState((current) => ({
            ...current,
            remoteDisplays: message.displays,
            remoteSelectedDisplayId: message.selectedDisplayId,
          }))
        } else if (message.type === 'display.select' && role === 'host') {
          if (!sessionSelectionRateGuard.tryConsume(message.type, Date.now())) {
            failClosed('Ekran seçimi veri hızı güvenli sınırı aştı.')
            return
          }
          if (localDisplaysRef.current.some((display) => display.id === message.displayId)) {
            onDisplaySelectRef.current?.(message.displayId)
          }
        } else if (message.type === 'quality.state' && role === 'guest' && !disposed) {
          setState((current) => ({
            ...current,
            remoteQualityProfile: message.profile,
          }))
        } else if (message.type === 'quality.select' && role === 'host') {
          if (!sessionSelectionRateGuard.tryConsume(message.type, Date.now())) {
            failClosed('Kalite seçimi veri hızı güvenli sınırı aştı.')
            return
          }
          onQualityProfileSelectRef.current?.(message.profile)
        } else if (message.type === 'media.state' && role === 'guest' && !disposed) {
          setState((current) => ({
            ...current,
            remoteMediaState: message.state,
            remoteScreenActive:
              message.state === 'sharing' ? current.remoteScreenActive : false,
            remoteStream:
              message.state === 'sharing' ? current.remoteStream : null,
          }))
        } else if (message.type === 'cursor.state' && role === 'guest' && !disposed) {
          publishRemoteCursor(message)
        }
      })

      channel.addEventListener('close', () => {
        updatePeerDiagnostics((diagnostics) => {
          diagnostics.dataChannels[channel.label] = channel.readyState
        })
        if (disposed || fatalFailureLatched) return
        if (channelKind === 'reliable' && reliableDataChannel === channel) {
          if (pointerDataChannel?.readyState !== 'closed') pointerDataChannel?.close()
          pointerDataChannel = null
          pointerChannelRef.current = null
          reliableDataChannel = null
          dataChannelRef.current = null
          if (pingTimer !== null) {
            window.clearInterval(pingTimer)
            pingTimer = null
          }
          pendingPings.clear()
          disableControlTransport('disconnected', null)
        } else if (channelKind === 'pointer' && pointerDataChannel === channel) {
          pointerDataChannel = null
          pointerChannelRef.current = null
        }
      })
      channel.addEventListener('error', () => {
        updatePeerDiagnostics((diagnostics) => {
          diagnostics.dataChannels[channel.label] = channel.readyState
        })
        if (disposed || fatalFailureLatched) return
        if (channelKind === 'reliable' && reliableDataChannel === channel) {
          failClosed('WebRTC veri kanalı hata verdi.')
        } else if (channelKind === 'pointer' && pointerDataChannel === channel) {
          pointerDataChannel = null
          pointerChannelRef.current = null
        }
      })
    }

    const negotiate = async () => {
      if (
        role !== 'host' ||
        makingOffer ||
        fatalFailureLatched ||
        peerConnection.signalingState === 'closed'
      ) {
        return
      }
      makingOffer = true
      const negotiationId = crypto.randomUUID()
      activeNegotiationId = negotiationId
      activeLocalIceGeneration = null
      localDescriptionPublished = false
      pendingLocalCandidates.beginNegotiation(negotiationId)
      pendingRemoteCandidates.beginNegotiation(negotiationId)
      try {
        const offer = await peerConnection.createOffer()
        if (disposed || fatalFailureLatched || activeNegotiationId !== negotiationId) return
        const localIceGeneration = bindLocalIceGeneration(negotiationId, offer.sdp)
        if (!localIceGeneration) {
          throw new Error('Yerel ICE nesil kimliği SDP teklifinde bulunamadı.')
        }
        activeLocalIceGeneration = localIceGeneration
        await peerConnection.setLocalDescription(offer)
        if (disposed || fatalFailureLatched || activeNegotiationId !== negotiationId) return
        if (
          peerConnection.localDescription &&
          !sendSignal({
            kind: 'session-description',
            negotiationId,
            description: peerConnection.localDescription.toJSON(),
          })
        ) {
          throw new Error('SDP teklifi sinyalleşme sunucusuna gönderilemedi.')
        }
        localDescriptionPublished = true
        for (const candidate of pendingLocalCandidates.drain(negotiationId)) {
          if (!sendSignal({ kind: 'ice-candidate', negotiationId, candidate })) {
            throw new Error('ICE adayı sinyalleşme sunucusuna gönderilemedi.')
          }
        }
      } finally {
        makingOffer = false
      }
    }
    renegotiateRef.current = negotiate

    peerConnection.addEventListener('icecandidate', (event) => {
      if (disposed || fatalFailureLatched) return
      const candidate = event.candidate
      if (candidate) {
        const negotiationId = resolveLocalCandidateNegotiationId(
          activeLocalIceGeneration,
          candidate,
        )
        if (!negotiationId || negotiationId !== activeNegotiationId) return
        updatePeerDiagnostics((diagnostics) => {
          diagnostics.localCandidates.push(
            candidateSummary(candidate.candidate),
          )
        })
        const candidateJson = {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        }
        if (!localDescriptionPublished) {
          const result = pendingLocalCandidates.tryEnqueue(
            negotiationId,
            candidateJson,
          )
          if (result === 'overflow') {
            failClosed('Yerel ICE aday kuyruğu güvenli sınırı aştı.')
          }
          return
        }
        if (!sendSignal({
          kind: 'ice-candidate',
          negotiationId,
          candidate: candidateJson,
        })) fail(new Error('ICE adayı sinyalleşme sunucusuna gönderilemedi.'))
      }
    })
    peerConnection.addEventListener('icegatheringstatechange', () => {
      updatePeerDiagnostics((diagnostics) => {
        diagnostics.iceGatheringState = peerConnection.iceGatheringState
      })
    })
    peerConnection.addEventListener('icecandidateerror', (event) => {
      if (disposed || fatalFailureLatched) return
      if (event.errorCode === 701) return
      setState((current) => ({
        ...current,
        error: 'Bağlantı sunucusuna ulaşılamadı. Alternatif yol deneniyor.',
      }))
    })

    peerConnection.addEventListener('iceconnectionstatechange', () => {
      updatePeerDiagnostics((diagnostics) => {
        diagnostics.iceConnectionState = peerConnection.iceConnectionState
      })
      if (
        peerConnection.iceConnectionState === 'connected' ||
        peerConnection.iceConnectionState === 'completed'
      ) {
        iceRestartAttemptsRef.current = 0
        void refreshConnectionPath()
      }
    })

    peerConnection.addEventListener('connectionstatechange', () => {
      updatePeerDiagnostics((diagnostics) => {
        diagnostics.connectionState = peerConnection.connectionState
      })
      if (disposed || fatalFailureLatched) return
      if (peerConnection.connectionState === 'failed') {
        disableControlTransport(
          'failed',
          'Cihazlar arasında güvenli bağlantı kesildi.',
        )
        scheduleIceRestart(500)
      } else if (peerConnection.connectionState === 'disconnected') {
        disableControlTransport('disconnected', null)
        scheduleIceRestart(3_000)
      } else if (peerConnection.connectionState === 'connected') {
        iceRestartAttemptsRef.current = 0
        transportConnectedRef.current = true
        if (reliableDataChannel?.readyState === 'open') {
          if (role === 'host') {
            controlGrantedRef.current = controlAllowedRef.current
          }
          setState((current) => ({
            ...current,
            status: 'connected',
            controlGranted:
              role === 'host' ? controlAllowedRef.current : current.controlGranted,
            error: null,
          }))
          sendPing()
          if (role === 'host') {
            postDesktopMessage({
              type: 'desktop.control.set-enabled',
              channel: 'control',
              version: 1,
              sessionId: nativeControlSessionId,
              enabled: controlAllowedRef.current,
            })
            sendScreenShareState()
            sendControlState()
            sendDisplayList()
            sendQualityState()
            sendMediaState()
          }
        }
      }
    })

    peerConnection.addEventListener('datachannel', (event) => {
      if (fatalFailureLatched) {
        event.channel.close()
        return
      }
      if (role !== 'guest') {
        event.channel.close()
        return
      }
      if (event.channel.label === 'ediz-remote-control') {
        attachDataChannel(event.channel, 'reliable')
      } else if (event.channel.label === 'ediz-remote-pointer') {
        attachDataChannel(event.channel, 'pointer')
      } else {
        event.channel.close()
      }
    })

    peerConnection.addEventListener('track', (event) => {
      if (fatalFailureLatched) {
        event.track.stop()
        return
      }
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        if (!inboundStream.getTracks().some((current) => current.id === track.id)) {
          inboundStream.addTrack(track)
          track.addEventListener('ended', () => {
            inboundStream.removeTrack(track)
            if (!disposed && !fatalFailureLatched) {
              const remainingTracks = inboundStream.getTracks()
              setState((current) => ({
                ...current,
                remoteStream:
                  remainingTracks.length > 0 ? new MediaStream(remainingTracks) : null,
              }))
            }
          }, { once: true })
        }
      }
      if (!disposed && !fatalFailureLatched) {
        setState((current) => ({
          ...current,
          remoteStream: new MediaStream(inboundStream.getTracks()),
          remoteScreenActive: true,
        }))
      }
    })

    const flushPendingCandidates = async (negotiationId: string) => {
      for (const candidate of pendingRemoteCandidates.drain(negotiationId)) {
        await peerConnection.addIceCandidate(candidate)
        if (disposed || fatalFailureLatched || activeNegotiationId !== negotiationId) return
      }
    }

    const handleSignal = async (payload: unknown) => {
      const signal = parsePeerSignal(payload)
      if (!signal || disposed || fatalFailureLatched) return
      if (signal.kind === 'ice-candidate') {
        if (
          activeNegotiationId !== null &&
          signal.negotiationId !== activeNegotiationId
        ) return
        updatePeerDiagnostics((diagnostics) => {
          diagnostics.remoteCandidates.push(
            candidateSummary(signal.candidate.candidate ?? ''),
          )
        })
        if (
          peerConnection.remoteDescription &&
          activeNegotiationId === signal.negotiationId
        ) {
          await peerConnection.addIceCandidate(signal.candidate)
        } else {
          const result = pendingRemoteCandidates.tryEnqueue(
            signal.negotiationId,
            signal.candidate,
          )
          if (result === 'overflow') {
            failClosed('Uzak ICE aday kuyruğu güvenli sınırı aştı.')
          }
        }
        return
      }

      if (signal.description.type === 'offer' && role === 'guest') {
        const negotiationId = signal.negotiationId
        activeNegotiationId = negotiationId
        activeLocalIceGeneration = null
        localDescriptionPublished = false
        pendingRemoteCandidates.beginNegotiation(negotiationId)
        pendingLocalCandidates.beginNegotiation(negotiationId)
        await peerConnection.setRemoteDescription(signal.description)
        if (disposed || fatalFailureLatched || activeNegotiationId !== negotiationId) return
        await flushPendingCandidates(negotiationId)
        if (disposed || fatalFailureLatched || activeNegotiationId !== negotiationId) return
        const answer = await peerConnection.createAnswer()
        if (disposed || fatalFailureLatched || activeNegotiationId !== negotiationId) return
        const localIceGeneration = bindLocalIceGeneration(negotiationId, answer.sdp)
        if (!localIceGeneration) {
          throw new Error('Yerel ICE nesil kimliği SDP yanıtında bulunamadı.')
        }
        activeLocalIceGeneration = localIceGeneration
        await peerConnection.setLocalDescription(answer)
        if (disposed || fatalFailureLatched || activeNegotiationId !== negotiationId) return
        if (peerConnection.localDescription) {
          if (!sendSignal({
            kind: 'session-description',
            negotiationId,
            description: peerConnection.localDescription.toJSON(),
          })) throw new Error('SDP yanıtı sinyalleşme sunucusuna gönderilemedi.')
          localDescriptionPublished = true
          for (const candidate of pendingLocalCandidates.drain(negotiationId)) {
            if (!sendSignal({ kind: 'ice-candidate', negotiationId, candidate })) {
              throw new Error('ICE adayı sinyalleşme sunucusuna gönderilemedi.')
            }
          }
        }
      } else if (signal.description.type === 'answer' && role === 'host') {
        if (signal.negotiationId !== activeNegotiationId) return
        const negotiationId = signal.negotiationId
        await peerConnection.setRemoteDescription(signal.description)
        if (disposed || fatalFailureLatched || activeNegotiationId !== negotiationId) return
        await flushPendingCandidates(negotiationId)
      }
    }

    const unsubscribe = subscribeToSignals('peer', (payload) => {
      signalChain = signalChain
        .then(() => handleSignal(payload))
        .catch(() => failClosed('WebRTC sinyali güvenli biçimde uygulanamadı.'))
    })

    if (role === 'host') {
      attachDataChannel(
        peerConnection.createDataChannel('ediz-remote-control', { ordered: true }),
        'reliable',
      )
      attachDataChannel(
        peerConnection.createDataChannel('ediz-remote-pointer', {
          ordered: false,
          maxRetransmits: 0,
        }),
        'pointer',
      )
      void negotiate().catch(() => {
        failClosed('WebRTC negotiation güvenli biçimde tamamlanamadı.')
      })
    }

    return () => {
      disposed = true
      transportConnectedRef.current = false
      unsubscribe()
      unsubscribeDesktopCursor()
      publishRemoteCursor({ sequence: 0, x: 0, y: 0, visible: false })
      if (pingTimer !== null) window.clearInterval(pingTimer)
      if (iceRestartTimer !== null) window.clearTimeout(iceRestartTimer)
      reliableDataChannel?.close()
      pointerDataChannel?.close()
      peerConnection.close()
      controlGrantedRef.current = false
      reliableControlSequenceRef.current = 0
      pointerControlSequenceRef.current = 0
      if (role === 'host') {
        postDesktopMessage({
          type: 'desktop.control.set-enabled',
          channel: 'control',
          version: 1,
          sessionId: nativeControlSessionId,
          enabled: false,
        })
        if (nativeControlSessionIdRef.current === nativeControlSessionId) {
          nativeControlSessionIdRef.current = null
        }
      }
      if (peerConnectionRef.current === peerConnection) {
        peerConnectionRef.current = null
        dataChannelRef.current = null
        pointerChannelRef.current = null
        renegotiateRef.current = null
      }
    }
  }, [
    enabled,
    iceConfiguration,
    requestIceRefresh,
    retryVersion,
    role,
    sessionState,
    sendSignal,
    subscribeToSignals,
    takeLocalSessionSequence,
  ])

  useEffect(() => {
    if (!enabled || role !== 'host') return
    const peerConnection = peerConnectionRef.current
    if (!peerConnection) return

    const desiredTracks = new Set(localStream?.getVideoTracks() ?? [])
    let changed = false
    for (const sender of peerConnection.getSenders()) {
      if (sender.track?.kind === 'video' && !desiredTracks.has(sender.track)) {
        peerConnection.removeTrack(sender)
        changed = true
      }
    }
    const currentTracks = new Set(
      peerConnection.getSenders().map((sender) => sender.track).filter(Boolean),
    )
    for (const track of desiredTracks) {
      if (!currentTracks.has(track) && localStream) {
        peerConnection.addTrack(track, localStream)
        changed = true
      }
    }
    if (changed) void renegotiateRef.current?.().catch(() => undefined)
    const dataChannel = dataChannelRef.current
    if (
      dataChannel?.readyState === 'open' &&
      transportConnectedRef.current
    ) {
      const sequence = takeLocalSessionSequence()
      if (sequence === null) return
      dataChannel.send(
        JSON.stringify({
          channel: 'session',
          version: 2,
          type: 'screen-share-state',
          sequence,
          active: desiredTracks.size > 0,
        } satisfies DataChannelMessage),
      )
    }
  }, [enabled, localStream, role, takeLocalSessionSequence])

  useEffect(() => {
    if (!enabled || role !== 'host') return
    const sessionId = nativeControlSessionIdRef.current
    const dataChannel = dataChannelRef.current
    const transportReady =
      transportConnectedRef.current && dataChannel?.readyState === 'open'
    const effectiveControl = controlAllowed && transportReady
    controlGrantedRef.current = effectiveControl
    setState((current) => ({ ...current, controlGranted: effectiveControl }))
    if (sessionId) {
      postDesktopMessage({
        type: 'desktop.control.set-enabled',
        channel: 'control',
        version: 1,
        sessionId,
        enabled: effectiveControl,
      })
    }
    if (!transportReady) return
    dataChannel.send(
      JSON.stringify(
        controlAllowed
          ? {
              channel: 'control',
              version: 1,
              type: 'control.granted',
              capabilities: ['pointer', 'keyboard'],
            }
          : {
              channel: 'control',
              version: 1,
              type: 'control.revoked',
              reason: 'host',
            },
      ),
    )
  }, [controlAllowed, enabled, role])

  useEffect(() => {
    if (!enabled || role !== 'host') return
    const channel = dataChannelRef.current
    if (
      channel?.readyState !== 'open' ||
      !transportConnectedRef.current
    ) return
    const sequence = takeLocalSessionSequence()
    if (sequence === null) return
    channel.send(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'display.list',
      sequence,
      displays: localDisplays,
      selectedDisplayId:
        selectedDisplayId &&
        localDisplays.some((display) => display.id === selectedDisplayId)
          ? selectedDisplayId
          : null,
    } satisfies DataChannelMessage))
  }, [enabled, localDisplays, role, selectedDisplayId, takeLocalSessionSequence])

  useEffect(() => {
    if (!enabled || role !== 'host') return
    const channel = dataChannelRef.current
    if (
      channel?.readyState !== 'open' ||
      !transportConnectedRef.current
    ) return
    const sequence = takeLocalSessionSequence()
    if (sequence === null) return
    channel.send(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'quality.state',
      sequence,
      profile: localQualityProfile,
    } satisfies DataChannelMessage))
  }, [enabled, localQualityProfile, role, takeLocalSessionSequence])

  useEffect(() => {
    if (!enabled || role !== 'host') return
    const channel = dataChannelRef.current
    if (
      channel?.readyState !== 'open' ||
      !transportConnectedRef.current
    ) return
    const sequence = takeLocalSessionSequence()
    if (sequence === null) return
    channel.send(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'media.state',
      sequence,
      state: localMediaState,
    } satisfies DataChannelMessage))
  }, [enabled, localMediaState, role, takeLocalSessionSequence])

  return {
    ...state,
    retry,
    sendControlEvent,
    selectRemoteDisplay,
    selectQualityProfile,
    subscribeToRemoteCursor,
  }
}
