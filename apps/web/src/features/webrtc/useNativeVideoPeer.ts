import { useCallback, useEffect, useRef, useState } from 'react'
import {
  negotiationIdSchema,
  type IceConfiguration,
} from '@ediz-remote/protocol'
import type { SessionRole, SessionState } from '../session/useSignaling'
import {
  getRuntimeConfiguration,
  postDesktopMessage,
  subscribeToDesktopMessages,
} from '../desktop/useDesktopBridge'
import {
  parseNativeVideoSignalEnvelope,
  type NativeVideoSignalEnvelope,
  type PeerSignal,
} from './peerProtocol'
import {
  resolveIceServers,
  resolveIceTransportPolicy,
} from './iceConfiguration'
import {
  useLaneIceConfiguration,
  type LaneRetryOptions,
} from './laneIceConfiguration'
import {
  PendingIceCandidateQueue,
  bindLocalIceGeneration,
  resolveLocalCandidateNegotiationId,
  type LocalIceGenerationBinding,
} from './negotiation'

export type NativeVideoStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'

export interface NativeVideoPeerState {
  status: NativeVideoStatus
  remoteStream: MediaStream | null
  error: string | null
  active: boolean
  metrics: NativeVideoMetrics | null
}

export interface NativeVideoPeerController extends NativeVideoPeerState {
  retry: (options?: LaneRetryOptions) => void
}

export interface NativeVideoMetrics {
  packetLossPercent: number | null
  jitterMilliseconds: number | null
  targetBitrate: number
  nackRequests: number
  retransmittedPackets: number
  pliRequests: number
}

interface UseNativeVideoPeerOptions {
  enabled: boolean
  sessionState: SessionState
  role: SessionRole | null
  iceConfiguration: IceConfiguration | null
  iceResetVersion: number
  sendSignal: (payload: unknown) => boolean
  subscribeToSignals: (
    lane: 'peer' | 'native-video',
    handler: (payload: unknown) => void,
  ) => () => boolean
  requestIceRefresh: () => boolean
}

const IDLE_STATE: NativeVideoPeerState = {
  status: 'idle',
  remoteStream: null,
  error: null,
  active: false,
  metrics: null,
}

export function toSafeNativeTransportFailureState(
  current: NativeVideoPeerState,
  status: 'disconnected' | 'failed',
): NativeVideoPeerState {
  return {
    ...current,
    status,
    remoteStream: null,
    error: status === 'failed'
      ? 'Güvenli ekran görüntüsü bağlantısı kesildi.'
      : 'Ekran görüntüsü bağlantısı kesildi; yeniden bağlanılıyor.',
    metrics: null,
  }
}

export function useNativeVideoPeer({
  enabled,
  sessionState,
  role,
  iceConfiguration,
  iceResetVersion,
  sendSignal,
  subscribeToSignals,
  requestIceRefresh,
}: UseNativeVideoPeerOptions): NativeVideoPeerController {
  const [state, setState] = useState<NativeVideoPeerState>(IDLE_STATE)
  const [retryVersion, setRetryVersion] = useState(0)
  const {
    iceConfigurationRef,
    ownIceRefreshVersion,
    requestOwnIceRefresh,
    awaitOwnIceRefresh,
  } = useLaneIceConfiguration(iceConfiguration, iceResetVersion, requestIceRefresh)
  const hasIceConfiguration = iceConfiguration !== null
  const recoveryAttemptsRef = useRef(0)
  const fatalLatchRef = useRef<NativeNegotiationFatalLatch | null>(null)
  if (fatalLatchRef.current === null) {
    fatalLatchRef.current = new NativeNegotiationFatalLatch()
  }
  const retry = useCallback((options?: LaneRetryOptions) => {
    fatalLatchRef.current?.reset()
    recoveryAttemptsRef.current = 0
    if (options?.awaitIceRefresh) awaitOwnIceRefresh()
    setRetryVersion((current) => current + 1)
  }, [awaitOwnIceRefresh])

  useEffect(() => {
    const fatalLatch = fatalLatchRef.current!
    const laneIceConfiguration = iceConfigurationRef.current
    const approvedSessionContinues =
      sessionState === 'active' || sessionState === 'recovering'
    if (!approvedSessionContinues) fatalLatch.reset()
    if (!enabled || !role) {
      recoveryAttemptsRef.current = 0
      setState(IDLE_STATE)
      return
    }

    const nativeHost = role === 'host' && getRuntimeConfiguration().desktop === true
    if (role === 'host' && !nativeHost) {
      setState(IDLE_STATE)
      return
    }

    let disposed = false
    let signalChain = Promise.resolve()
    let peerConnection: RTCPeerConnection | null = null
    let recoveryTimer: number | null = null
    let activeNegotiationId: string | null = null
    let activeLocalIceGeneration: LocalIceGenerationBinding | null = null
    let localDescriptionPublished = false
    const pendingRemoteCandidates = new PendingIceCandidateQueue()
    const pendingLocalCandidates = new PendingIceCandidateQueue()
    const desktopNegotiations = new DesktopNativeNegotiationTracker()
    const bridgeSessionEpoch = crypto.randomUUID()
    let desktopStopPosted = false

    if (fatalLatch.tripped) {
      setState({
        status: 'failed',
        remoteStream: null,
        error: 'Güvenli ekran görüntüsü kullanıcı yeniden denemesi bekliyor.',
        active: true,
        metrics: null,
      })
      return
    }

    setState({
      status: 'connecting',
      remoteStream: null,
      error: null,
      active: true,
      metrics: null,
    })

    const showFailure = (_error: unknown) => {
      if (disposed) return
      setState({
        status: 'failed',
        remoteStream: null,
        error: 'Güvenli ekran görüntüsü bağlantısı kurulamadı.',
        active: true,
        metrics: null,
      })
    }

    const stopDesktopNativeSession = () => {
      if (!nativeHost || desktopStopPosted) return
      desktopStopPosted = true
      postDesktopMessage({
        type: 'desktop.native-video.stop',
        channel: 'native-video',
        version: 2,
        sessionEpoch: bridgeSessionEpoch,
      })
    }

    const failFatal = (error: unknown) => {
      if (disposed || !tripFatalNativeNegotiation(
        fatalLatch,
        peerConnection,
        [pendingRemoteCandidates, pendingLocalCandidates],
      )) return
      localDescriptionPublished = false
      activeLocalIceGeneration = null
      if (recoveryTimer !== null) {
        window.clearTimeout(recoveryTimer)
        recoveryTimer = null
      }
      stopDesktopNativeSession()
      showFailure(error)
    }

    const scheduleRecovery = () => {
      if (disposed || fatalLatch.tripped || recoveryTimer !== null) return
      if (recoveryAttemptsRef.current >= 3) {
        failFatal(new Error('Native H.264 ICE bağlantısı üç denemeden sonra kurulamadı.'))
        return
      }
      recoveryTimer = window.setTimeout(() => {
        recoveryTimer = null
        recoveryAttemptsRef.current += 1
        if (!requestOwnIceRefresh()) scheduleRecovery()
      }, 1_000 * 2 ** recoveryAttemptsRef.current)
    }

    const sendNativeSignal = (signal: PeerSignal) => {
      if (disposed || fatalLatch.tripped) return
      const envelope: NativeVideoSignalEnvelope = {
        channel: 'native-video',
        version: 2,
        signal,
      }
      if (!sendSignal(envelope)) {
        throw new Error('Native video sinyali sunucuya gönderilemedi.')
      }
    }

    const unsubscribeDesktop = nativeHost
      ? subscribeToDesktopMessages((event) => {
          const message = parseDesktopNativeMessage(event.data, bridgeSessionEpoch)
          if (!message || disposed || fatalLatch.tripped) return
          const disposition = desktopNegotiations.accept(message)
          if (disposition === 'exhausted') {
            failFatal(new Error('Native video negotiation kimliği sınırı aşıldı.'))
            stopDesktopNativeSession()
            return
          }
          if (disposition === 'stale') return
          activeNegotiationId = desktopNegotiations.activeNegotiationId
          if (message.type === 'desktop.native-video.signal') {
            try {
              sendNativeSignal(message.payload)
            } catch (error) {
              failFatal(error)
              stopDesktopNativeSession()
            }
          } else if (message.type === 'desktop.native-video.state') {
            const status = parseNativeStatus(message.payload.state)
            setState((current) => ({
              ...current,
              status,
              error:
                status === 'failed'
                  ? 'Windows ekran aktarımı başlatılamadı.'
                  : null,
            }))
            if (status === 'connected') {
              recoveryAttemptsRef.current = 0
            } else if (status === 'disconnected') {
              // Only the native peer transport reports disconnected/closed,
              // e.g. after the guest rebuilt its receiver. Re-offer with a
              // fresh credential; bridge and negotiation faults report
              // `failed` and keep waiting for the user's retry.
              scheduleRecovery()
            }
          } else if (message.type === 'desktop.native-video.metrics') {
            setState((current) => ({ ...current, metrics: message.payload }))
          }
        })
      : () => undefined

    if (!nativeHost) {
      peerConnection = new RTCPeerConnection({
        iceServers: resolveIceServers(laneIceConfiguration),
        bundlePolicy: 'max-bundle',
        iceTransportPolicy: resolveIceTransportPolicy(),
      })
      const connection = peerConnection
      const inboundStream = new MediaStream()

      connection.addEventListener('icecandidate', (event) => {
        if (disposed || fatalLatch.tripped) return
        if (event.candidate) {
          try {
            const negotiationId = resolveLocalCandidateNegotiationId(
              activeLocalIceGeneration,
              event.candidate,
            )
            if (!negotiationId || negotiationId !== activeNegotiationId) return
            const signal: PeerSignal = {
              kind: 'ice-candidate',
              negotiationId,
              candidate: {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                usernameFragment: event.candidate.usernameFragment,
              },
            }
            if (!localDescriptionPublished) {
              const result = pendingLocalCandidates.tryEnqueue(
                negotiationId,
                signal.candidate,
              )
              if (result === 'overflow') {
                failFatal(new Error('Yerel native ICE aday kuyruğu doldu.'))
              }
              return
            }
            sendNativeSignal(signal)
          } catch (error) {
            failFatal(error)
          }
        }
      })
      connection.addEventListener('icecandidateerror', () => {
        if (disposed || fatalLatch.tripped) return
        setState((current) => ({
          ...current,
          error: 'Görüntü bağlantısı için alternatif ağ yolu deneniyor.',
        }))
      })
      connection.addEventListener('track', (event) => {
        if (disposed || fatalLatch.tripped) return
        if (!inboundStream.getTracks().some((track) => track.id === event.track.id)) {
          inboundStream.addTrack(event.track)
        }
        if (!disposed) {
          setState({
            status: 'connected',
            remoteStream: new MediaStream(inboundStream.getTracks()),
            error: null,
            active: true,
            metrics: null,
          })
        }
      })
      connection.addEventListener('connectionstatechange', () => {
        if (disposed || fatalLatch.tripped) return
        if (connection.connectionState === 'failed') {
          setState((current) =>
            toSafeNativeTransportFailureState(current, 'failed'))
          scheduleRecovery()
        } else if (connection.connectionState === 'disconnected') {
          setState((current) =>
            toSafeNativeTransportFailureState(current, 'disconnected'))
          scheduleRecovery()
        } else if (connection.connectionState === 'connected') {
          recoveryAttemptsRef.current = 0
          setState((current) => ({
            ...current,
            status: 'connected',
            remoteStream: inboundStream.getTracks().length > 0
              ? new MediaStream(inboundStream.getTracks())
              : null,
            error: null,
          }))
        }
      })
    }

    const flushPendingCandidates = async (negotiationId: string) => {
      if (!peerConnection || disposed || fatalLatch.tripped) return
      for (const candidate of pendingRemoteCandidates.drain(negotiationId)) {
        await peerConnection.addIceCandidate(candidate)
        if (
          disposed ||
          fatalLatch.tripped ||
          activeNegotiationId !== negotiationId
        ) return
      }
    }

    const handleGuestSignal = async (signal: PeerSignal) => {
      if (!peerConnection || disposed || fatalLatch.tripped) return
      if (signal.kind === 'ice-candidate') {
        if (
          activeNegotiationId !== null &&
          signal.negotiationId !== activeNegotiationId
        ) return
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
            failFatal(new Error('Uzak native ICE aday kuyruğu doldu.'))
          }
        }
        return
      }
      if (signal.description.type !== 'offer') return
      const negotiationId = signal.negotiationId
      activeNegotiationId = negotiationId
      activeLocalIceGeneration = null
      localDescriptionPublished = false
      pendingRemoteCandidates.beginNegotiation(negotiationId)
      pendingLocalCandidates.beginNegotiation(negotiationId)
      await peerConnection.setRemoteDescription(signal.description)
      if (
        disposed ||
        fatalLatch.tripped ||
        activeNegotiationId !== negotiationId
      ) return
      await flushPendingCandidates(negotiationId)
      if (
        disposed ||
        fatalLatch.tripped ||
        activeNegotiationId !== negotiationId
      ) return
      const answer = await peerConnection.createAnswer()
      if (
        disposed ||
        fatalLatch.tripped ||
        activeNegotiationId !== negotiationId
      ) return
      const localIceGeneration = bindLocalIceGeneration(negotiationId, answer.sdp)
      if (!localIceGeneration) {
        throw new Error('Yerel native ICE nesil kimliği SDP yanıtında bulunamadı.')
      }
      activeLocalIceGeneration = localIceGeneration
      await peerConnection.setLocalDescription(answer)
      if (
        disposed ||
        fatalLatch.tripped ||
        activeNegotiationId !== negotiationId
      ) return
      if (peerConnection.localDescription) {
        sendNativeSignal({
          kind: 'session-description',
          negotiationId,
          description: {
            type: 'answer',
            sdp: peerConnection.localDescription.sdp,
          },
        })
        localDescriptionPublished = true
        for (const candidate of pendingLocalCandidates.drain(negotiationId)) {
          sendNativeSignal({ kind: 'ice-candidate', negotiationId, candidate })
        }
      }
    }

    const unsubscribeSignals = subscribeToSignals('native-video', (payload) => {
      const envelope = parseNativeVideoSignalEnvelope(payload)
      if (!envelope || disposed || fatalLatch.tripped) return
      if (nativeHost) {
        postDesktopMessage({
          type: 'desktop.native-video.signal',
          channel: 'native-video',
          version: 2,
          sessionEpoch: bridgeSessionEpoch,
          payload: envelope.signal,
        })
      } else {
        signalChain = signalChain
          .then(() => handleGuestSignal(envelope.signal))
          .catch(failFatal)
      }
    })

    if (nativeHost) {
      postDesktopMessage({
        type: 'desktop.native-video.start',
        channel: 'native-video',
        version: 2,
        sessionEpoch: bridgeSessionEpoch,
        iceServers: resolveIceServers(laneIceConfiguration),
      })
    }

    return () => {
      disposed = true
      pendingRemoteCandidates.clear()
      pendingLocalCandidates.clear()
      unsubscribeSignals()
      unsubscribeDesktop()
      peerConnection?.close()
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer)
      stopDesktopNativeSession()
    }
  }, [
    enabled,
    hasIceConfiguration,
    iceConfigurationRef,
    iceResetVersion,
    ownIceRefreshVersion,
    requestOwnIceRefresh,
    retryVersion,
    role,
    sessionState,
    sendSignal,
    subscribeToSignals,
  ])

  return { ...state, retry }
}

export type DesktopNativeMessage =
  | {
      type: 'desktop.native-video.negotiation'
      channel: 'native-video'
      version: 2
      sessionEpoch: string
      negotiationId: string
      payload: Record<string, never>
    }
  | {
      type: 'desktop.native-video.signal'
      channel: 'native-video'
      version: 2
      sessionEpoch: string
      payload: PeerSignal
    }
  | {
      type: 'desktop.native-video.state'
      channel: 'native-video'
      version: 2
      sessionEpoch: string
      negotiationId: string
      payload: { state: DesktopNativeVideoState }
    }
  | {
      type: 'desktop.native-video.metrics'
      channel: 'native-video'
      version: 2
      sessionEpoch: string
      negotiationId: string
      payload: NativeVideoMetrics
    }

type DesktopNativeVideoState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed'

export function parseDesktopNativeMessage(
  value: unknown,
  expectedSessionEpoch: string,
): DesktopNativeMessage | null {
  if (
    !isRecord(value) ||
    value.channel !== 'native-video' ||
    value.version !== 2 ||
    value.sessionEpoch !== expectedSessionEpoch ||
    !isRecord(value.payload)
  ) {
    return null
  }
  if (
    value.type === 'desktop.native-video.negotiation' &&
    hasExactlyKeys(value, [
      'type',
      'channel',
      'version',
      'sessionEpoch',
      'negotiationId',
      'payload',
    ]) &&
    isUuid(value.negotiationId) &&
    hasExactlyKeys(value.payload, [])
  ) {
    return {
      type: value.type,
      channel: 'native-video',
      version: 2,
      sessionEpoch: expectedSessionEpoch,
      negotiationId: value.negotiationId,
      payload: {},
    }
  }
  if (value.type === 'desktop.native-video.signal') {
    if (!hasExactlyKeys(value, [
      'type',
      'channel',
      'version',
      'sessionEpoch',
      'payload',
    ])) return null
    const envelope = parseNativeVideoSignalEnvelope({
      channel: 'native-video',
      version: 2,
      signal: value.payload,
    })
    return envelope
      ? {
          type: value.type,
          channel: 'native-video',
          version: 2,
          sessionEpoch: expectedSessionEpoch,
          payload: envelope.signal,
        }
      : null
  }
  if (
    value.type === 'desktop.native-video.state' &&
    hasExactlyKeys(value, [
      'type',
      'channel',
      'version',
      'sessionEpoch',
      'negotiationId',
      'payload',
    ]) &&
    isUuid(value.negotiationId) &&
    hasExactlyKeys(value.payload, [
      'state',
      'errorCode',
      'recoveryAttempt',
      'recoveryMaximumAttempts',
    ]) &&
    isDesktopNativeVideoState(value.payload.state) &&
    isOptionalBoundedString(value.payload.errorCode, 64) &&
    isOptionalPositiveInteger(value.payload.recoveryAttempt) &&
    isOptionalPositiveInteger(value.payload.recoveryMaximumAttempts)
  ) {
    return {
      type: value.type,
      channel: 'native-video',
      version: 2,
      sessionEpoch: expectedSessionEpoch,
      negotiationId: value.negotiationId,
      payload: {
        state: value.payload.state,
      },
    }
  }
  if (value.type === 'desktop.native-video.metrics') {
    if (!hasExactlyKeys(value, [
      'type',
      'channel',
      'version',
      'sessionEpoch',
      'negotiationId',
      'payload',
    ]) || !isUuid(value.negotiationId)) return null
    if (!hasExactlyKeys(value.payload, [
      'packetLossPercent',
      'jitterMilliseconds',
      'targetBitrate',
      'nackRequests',
      'retransmittedPackets',
      'pliRequests',
    ])) return null
    const packetLossPercent = optionalNumber(value.payload.packetLossPercent)
    const jitterMilliseconds = optionalNumber(value.payload.jitterMilliseconds)
    const targetBitrate = requiredNumber(value.payload.targetBitrate)
    const nackRequests = requiredNumber(value.payload.nackRequests)
    const retransmittedPackets = requiredNumber(value.payload.retransmittedPackets)
    const pliRequests = requiredNumber(value.payload.pliRequests)
    if (
      targetBitrate === null ||
      nackRequests === null ||
      retransmittedPackets === null ||
      pliRequests === null
    ) {
      return null
    }
    return {
      type: value.type,
      channel: 'native-video',
      version: 2,
      sessionEpoch: expectedSessionEpoch,
      negotiationId: value.negotiationId,
      payload: {
        packetLossPercent,
        jitterMilliseconds,
        targetBitrate,
        nackRequests,
        retransmittedPackets,
        pliRequests,
      },
    }
  }
  return null
}

export const MAX_DESKTOP_NATIVE_NEGOTIATIONS = 256
export type DesktopNativeNegotiationDisposition =
  | 'accepted'
  | 'stale'
  | 'exhausted'

export class DesktopNativeNegotiationTracker {
  private readonly seenNegotiationIds = new Set<string>()
  private currentNegotiationId: string | null = null

  get activeNegotiationId(): string | null {
    return this.currentNegotiationId
  }

  accept(message: DesktopNativeMessage): DesktopNativeNegotiationDisposition {
    if (message.type === 'desktop.native-video.negotiation') {
      if (this.seenNegotiationIds.has(message.negotiationId)) return 'stale'
      if (this.seenNegotiationIds.size >= MAX_DESKTOP_NATIVE_NEGOTIATIONS) {
        return 'exhausted'
      }
      this.seenNegotiationIds.add(message.negotiationId)
      this.currentNegotiationId = message.negotiationId
      return 'accepted'
    }

    const negotiationId = message.type === 'desktop.native-video.signal'
      ? message.payload.negotiationId
      : message.negotiationId
    if (negotiationId !== this.currentNegotiationId) return 'stale'
    if (
      message.type === 'desktop.native-video.signal' &&
      message.payload.kind === 'session-description' &&
      message.payload.description.type !== 'offer'
    ) return 'stale'
    return 'accepted'
  }
}

export class NativeNegotiationFatalLatch {
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

interface ClearableCandidateQueue {
  clear: () => void
}

export function tripFatalNativeNegotiation(
  latch: NativeNegotiationFatalLatch,
  peerConnection: Pick<RTCPeerConnection, 'close'> | null,
  queues: readonly ClearableCandidateQueue[],
): boolean {
  if (!latch.trip()) return false
  for (const queue of queues) queue.clear()
  peerConnection?.close()
  return true
}

function parseNativeStatus(value: DesktopNativeVideoState): NativeVideoStatus {
  switch (value) {
    case 'new':
    case 'connecting':
      return 'connecting'
    case 'connected':
      return 'connected'
    case 'disconnected':
    case 'closed':
      return 'disconnected'
    case 'failed':
      return 'failed'
  }
}

function isDesktopNativeVideoState(
  value: unknown,
): value is DesktopNativeVideoState {
  return (
    value === 'new' ||
    value === 'connecting' ||
    value === 'connected' ||
    value === 'disconnected' ||
    value === 'failed' ||
    value === 'closed'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isUuid(value: unknown): value is string {
  return negotiationIdSchema.safeParse(value).success
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function requiredNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function optionalNumber(value: unknown): number | null {
  return value === null ? null : requiredNumber(value)
}

function isOptionalBoundedString(value: unknown, maximumLength: number): boolean {
  return value === null || (
    typeof value === 'string' && value.length > 0 && value.length <= maximumLength
  )
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === null || (
    Number.isSafeInteger(value) && (value as number) > 0
  )
}
