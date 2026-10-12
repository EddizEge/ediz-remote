import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IceConfiguration } from '@ediz-remote/protocol'

// Minimal dependency-aware hook runtime: both lanes render in one component,
// as in App.tsx, and effects re-run only when their dependencies change.
const hookRuntime = vi.hoisted(() => {
  interface EffectSlot {
    deps?: readonly unknown[]
    cleanup?: (() => void) | void
  }
  let slots: unknown[] = []
  let cursor = 0
  let dirty = false
  let pendingEffects: Array<{ slot: EffectSlot; effect: () => void | (() => void) }> = []

  const depsChanged = (
    previous: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
  ) =>
    !previous ||
    !next ||
    previous.length !== next.length ||
    previous.some((value, index) => !Object.is(value, next[index]))

  function nextSlot() {
    const slot = cursor
    cursor += 1
    return slot
  }

  return {
    beginRender() {
      cursor = 0
      dirty = false
      pendingEffects = []
    },
    flushEffects() {
      for (const { slot, effect } of pendingEffects) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.cleanup = effect()
      }
      pendingEffects = []
    },
    takeDirty() {
      const value = dirty
      dirty = false
      return value
    },
    reset() {
      for (const slot of slots) {
        const effectSlot = slot as EffectSlot | undefined
        if (
          effectSlot &&
          typeof effectSlot === 'object' &&
          'cleanup' in effectSlot &&
          typeof effectSlot.cleanup === 'function'
        ) {
          effectSlot.cleanup()
        }
      }
      slots = []
      cursor = 0
      dirty = false
      pendingEffects = []
    },
    useCallback<T>(callback: T, deps: readonly unknown[]) {
      const slot = nextSlot()
      const current = slots[slot] as { callback: T; deps: readonly unknown[] } | undefined
      if (!current || depsChanged(current.deps, deps)) {
        slots[slot] = { callback, deps }
        return callback
      }
      return current.callback
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      const slot = nextSlot()
      if (!(slot in slots)) slots[slot] = { cleanup: undefined } satisfies EffectSlot
      const effectSlot = slots[slot] as EffectSlot
      if (depsChanged(effectSlot.deps, deps)) {
        effectSlot.deps = deps
        pendingEffects.push({ slot: effectSlot, effect })
      }
    },
    useRef<T>(initialValue: T) {
      const slot = nextSlot()
      if (!(slot in slots)) slots[slot] = { current: initialValue }
      return slots[slot] as { current: T }
    },
    useState<T>(initialValue: T | (() => T)) {
      const slot = nextSlot()
      if (!(slot in slots)) {
        slots[slot] =
          typeof initialValue === 'function'
            ? (initialValue as () => T)()
            : initialValue
      }
      const setValue = (nextValue: T | ((current: T) => T)) => {
        const value =
          typeof nextValue === 'function'
            ? (nextValue as (current: T) => T)(slots[slot] as T)
            : nextValue
        if (!Object.is(value, slots[slot])) dirty = true
        slots[slot] = value
      }
      return [slots[slot] as T, setValue] as const
    },
  }
})

const desktopBridge = vi.hoisted(() => ({
  desktop: false,
  posted: [] as Array<Record<string, unknown>>,
  listeners: new Set<(event: { data: unknown }) => void>(),
}))

vi.mock('react', () => ({
  useCallback: hookRuntime.useCallback,
  useEffect: hookRuntime.useEffect,
  useRef: hookRuntime.useRef,
  useState: hookRuntime.useState,
}))

vi.mock('../desktop/useDesktopBridge', () => ({
  getRuntimeConfiguration: () => ({ desktop: desktopBridge.desktop }),
  parseDesktopCursorState: () => null,
  postDesktopMessage: (message: Record<string, unknown>) => {
    desktopBridge.posted.push(message)
  },
  subscribeToDesktopMessages: (listener: (event: { data: unknown }) => void) => {
    desktopBridge.listeners.add(listener)
    return () => desktopBridge.listeners.delete(listener)
  },
}))

import { usePeerConnection } from './usePeerConnection'
import {
  NATIVE_UNCONNECTED_FAILURE_TOLERANCE_MS,
  useNativeVideoPeer,
} from './useNativeVideoPeer'
import type { SessionRole, SessionState } from '../session/useSignaling'

type Listener = (event: Record<string, unknown>) => void

class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting'
  readonly label: string
  constructor(label: string) {
    this.label = label
  }
  addEventListener() {}
  send() {}
  close() {
    this.readyState = 'closed'
  }
}

class FakePeerConnection {
  static readonly instances: FakePeerConnection[] = []
  readonly configuration: RTCConfiguration
  connectionState: RTCPeerConnectionState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'
  iceGatheringState: RTCIceGatheringState = 'new'
  signalingState: RTCSignalingState = 'stable'
  localDescription: (RTCSessionDescriptionInit & { toJSON: () => unknown }) | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  closed = false
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration
    FakePeerConnection.instances.push(this)
  }

  // Only the general lane listens for inbound DataChannels.
  get lane(): 'peer' | 'native-video' {
    return this.listeners.has('datachannel') ? 'peer' : 'native-video'
  }

  get iceServerUrl(): string {
    return [this.configuration.iceServers?.[0]?.urls].flat()[0] as string
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  createDataChannel(label: string) {
    return new FakeDataChannel(label)
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: 'v=0\r\na=ice-ufrag:abcd\r\n' }
  }

  async createAnswer() {
    return { type: 'answer' as const, sdp: 'v=0\r\na=ice-ufrag:efgh\r\n' }
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = { ...description, toJSON: () => ({ ...description }) }
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
  }

  getSenders() {
    return []
  }

  close() {
    this.closed = true
    this.signalingState = 'closed'
    this.connectionState = 'closed'
  }

  emitConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state
    for (const listener of this.listeners.get('connectionstatechange') ?? []) {
      listener({})
    }
  }
}

class FakeMediaStream {
  getTracks() {
    return []
  }
  addTrack() {}
}

function iceConfigurationFor(name: string): IceConfiguration {
  return {
    version: 1,
    expiresAt: null,
    iceServers: [{ urls: [`stun:${name}.example.test:3478`] }],
  }
}

function peers(lane: 'peer' | 'native-video') {
  return FakePeerConnection.instances.filter((peer) => peer.lane === lane)
}

function openPeers(lane: 'peer' | 'native-video') {
  return peers(lane).filter((peer) => !peer.closed)
}

function nativeStarts() {
  return desktopBridge.posted.filter(
    (message) => message.type === 'desktop.native-video.start',
  )
}

function postFromDesktop(data: Record<string, unknown>) {
  for (const listener of [...desktopBridge.listeners]) listener({ data })
}

interface SignalingProps {
  role: SessionRole
  sessionState: SessionState
  iceConfiguration: IceConfiguration | null
  iceResetVersion: number
}

const NO_DISPLAYS: never[] = []
const sendSignal = vi.fn(() => true)
const signalHandlers = new Set<(payload: unknown) => void>()
const subscribeToSignals = (
  lane: 'peer' | 'native-video',
  handler: (payload: unknown) => void,
) => {
  if (lane !== 'native-video') return () => true
  signalHandlers.add(handler)
  return () => signalHandlers.delete(handler)
}

async function deliverNativeOffer(): Promise<string> {
  const negotiationId = crypto.randomUUID()
  for (const handler of [...signalHandlers]) {
    handler({
      channel: 'native-video',
      version: 2,
      signal: {
        kind: 'session-description',
        negotiationId,
        description: { type: 'offer', sdp: 'v=0' },
      },
    })
  }
  await vi.advanceTimersByTimeAsync(0)
  return negotiationId
}
let lastIceRefreshAt = Number.NEGATIVE_INFINITY
// Mirrors useSignaling: one shared refresh, throttled to once per second.
const requestIceRefresh = vi.fn(() => {
  const now = Date.now()
  if (now - lastIceRefreshAt < 1_000) return false
  lastIceRefreshAt = now
  return true
})

// The test runtime above replaces React; the render driver below re-renders
// until state settles, so the hooks are called through plain aliases.
const renderNativeVideoPeer = useNativeVideoPeer
const renderPeerConnection = usePeerConnection

function renderLanes(props: SignalingProps) {
  for (let pass = 0; pass < 20; pass += 1) {
    hookRuntime.beginRender()
    const enabled = props.sessionState === 'active'
    const native = renderNativeVideoPeer({
      enabled,
      sessionState: props.sessionState,
      role: props.role,
      iceConfiguration: props.iceConfiguration,
      iceResetVersion: props.iceResetVersion,
      sendSignal,
      subscribeToSignals,
      requestIceRefresh,
    })
    const peer = renderPeerConnection({
      enabled,
      sessionState: props.sessionState,
      role: props.role,
      localStream: null,
      controlAllowed: false,
      iceConfiguration: props.iceConfiguration,
      iceResetVersion: props.iceResetVersion,
      sendSignal,
      subscribeToSignals,
      requestIceRefresh,
      localDisplays: NO_DISPLAYS,
    })
    hookRuntime.flushEffects()
    if (!hookRuntime.takeDirty()) return { native, peer }
  }
  throw new Error('Hook render did not settle.')
}

beforeEach(() => {
  vi.useFakeTimers()
  hookRuntime.reset()
  FakePeerConnection.instances.length = 0
  desktopBridge.desktop = false
  desktopBridge.posted.length = 0
  desktopBridge.listeners.clear()
  lastIceRefreshAt = Number.NEGATIVE_INFINITY
  requestIceRefresh.mockClear()
  sendSignal.mockClear()
  signalHandlers.clear()
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
  vi.stubGlobal('MediaStream', FakeMediaStream)
})

afterEach(() => {
  hookRuntime.reset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('independent ICE refresh per negotiation lane', () => {
  it('keeps the general peer when the native lane refreshes its own ICE', async () => {
    let props: SignalingProps = {
      role: 'guest',
      sessionState: 'active',
      iceConfiguration: iceConfigurationFor('approved'),
      iceResetVersion: 1,
    }
    renderLanes(props)
    const [generalPeer] = peers('peer')
    const [nativePeer] = peers('native-video')
    expect(peers('peer')).toHaveLength(1)
    expect(peers('native-video')).toHaveLength(1)

    nativePeer.emitConnectionState('failed')
    await vi.advanceTimersByTimeAsync(NATIVE_UNCONNECTED_FAILURE_TOLERANCE_MS)
    expect(requestIceRefresh).toHaveBeenCalledTimes(1)

    props = { ...props, iceConfiguration: iceConfigurationFor('native-refresh') }
    renderLanes(props)

    expect(nativePeer.closed).toBe(true)
    expect(openPeers('native-video')).toHaveLength(1)
    expect(openPeers('native-video')[0].iceServerUrl)
      .toBe('stun:native-refresh.example.test:3478')
    expect(peers('peer')).toEqual([generalPeer])
    expect(generalPeer.closed).toBe(false)
  })

  it('rebuilds only the general peer for its own refresh', async () => {
    let props: SignalingProps = {
      role: 'guest',
      sessionState: 'active',
      iceConfiguration: iceConfigurationFor('approved'),
      iceResetVersion: 1,
    }
    renderLanes(props)
    const [generalPeer] = peers('peer')
    const [nativePeer] = peers('native-video')

    generalPeer.emitConnectionState('failed')
    await vi.advanceTimersByTimeAsync(500)
    expect(requestIceRefresh).toHaveBeenCalledTimes(1)

    props = { ...props, iceConfiguration: iceConfigurationFor('peer-refresh') }
    renderLanes(props)

    expect(generalPeer.closed).toBe(true)
    expect(openPeers('peer')).toHaveLength(1)
    expect(openPeers('peer')[0].iceServerUrl)
      .toBe('stun:peer-refresh.example.test:3478')
    expect(peers('native-video')).toEqual([nativePeer])
    expect(nativePeer.closed).toBe(false)

    // A later unrelated answer only updates the stored credential.
    props = { ...props, iceConfiguration: iceConfigurationFor('unrelated') }
    renderLanes(props)
    expect(peers('peer')).toHaveLength(2)
    expect(peers('native-video')).toHaveLength(1)
  })

  it('retries a throttled lane refresh and rebuilds each lane once', async () => {
    let props: SignalingProps = {
      role: 'guest',
      sessionState: 'active',
      iceConfiguration: iceConfigurationFor('approved'),
      iceResetVersion: 1,
    }
    renderLanes(props)
    const [generalPeer] = peers('peer')
    const [nativePeer] = peers('native-video')

    // The native receiver had connected, so it keeps the regular backoff.
    nativePeer.emitConnectionState('connected')
    generalPeer.emitConnectionState('failed')
    nativePeer.emitConnectionState('failed')
    await vi.advanceTimersByTimeAsync(500)
    props = { ...props, iceConfiguration: iceConfigurationFor('peer-refresh') }
    renderLanes(props)
    expect(peers('peer')).toHaveLength(2)
    expect(nativePeer.closed).toBe(false)

    // The native request inside the shared 1 s window is throttled...
    await vi.advanceTimersByTimeAsync(500)
    expect(requestIceRefresh.mock.results.map((result) => result.value))
      .toEqual([true, false])
    renderLanes(props)
    expect(nativePeer.closed).toBe(false)

    // ...and the lane's own backoff asks again.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(requestIceRefresh.mock.results.at(-1)?.value).toBe(true)
    props = { ...props, iceConfiguration: iceConfigurationFor('native-refresh') }
    renderLanes(props)
    expect(nativePeer.closed).toBe(true)
    expect(openPeers('native-video')[0].iceServerUrl)
      .toBe('stun:native-refresh.example.test:3478')
    expect(peers('peer')).toHaveLength(2)
    expect(openPeers('peer')[0].iceServerUrl)
      .toBe('stun:peer-refresh.example.test:3478')
  })

  it('rebuilds both lanes on resume', () => {
    let props: SignalingProps = {
      role: 'guest',
      sessionState: 'active',
      iceConfiguration: iceConfigurationFor('approved'),
      iceResetVersion: 1,
    }
    renderLanes(props)

    // The reset version alone rebuilds both lanes, independent of the
    // session state transition that accompanies it in useSignaling.
    props = {
      ...props,
      iceConfiguration: iceConfigurationFor('peer-resumed'),
      iceResetVersion: 2,
    }
    renderLanes(props)
    expect(peers('peer')).toHaveLength(2)
    expect(peers('native-video')).toHaveLength(2)
    expect(openPeers('peer')[0].iceServerUrl)
      .toBe('stun:peer-resumed.example.test:3478')
    expect(openPeers('native-video')[0].iceServerUrl)
      .toBe('stun:peer-resumed.example.test:3478')

    // Socket loss followed by session_resumed.
    props = { ...props, sessionState: 'recovering', iceConfiguration: null }
    renderLanes(props)
    expect(openPeers('peer')).toHaveLength(0)
    expect(openPeers('native-video')).toHaveLength(0)
    props = {
      ...props,
      sessionState: 'active',
      iceConfiguration: iceConfigurationFor('session-resumed'),
      iceResetVersion: 3,
    }
    renderLanes(props)
    expect(peers('peer')).toHaveLength(3)
    expect(peers('native-video')).toHaveLength(3)
    expect(openPeers('peer')[0].iceServerUrl)
      .toBe('stun:session-resumed.example.test:3478')
    expect(openPeers('native-video')[0].iceServerUrl)
      .toBe('stun:session-resumed.example.test:3478')
  })

  it('does not rebuild twice when a resume answers a pending lane refresh', async () => {
    let props: SignalingProps = {
      role: 'guest',
      sessionState: 'active',
      iceConfiguration: iceConfigurationFor('approved'),
      iceResetVersion: 1,
    }
    renderLanes(props)
    peers('native-video')[0].emitConnectionState('failed')
    await vi.advanceTimersByTimeAsync(NATIVE_UNCONNECTED_FAILURE_TOLERANCE_MS)
    expect(requestIceRefresh).toHaveBeenCalledTimes(1)

    props = {
      ...props,
      iceConfiguration: iceConfigurationFor('peer-resumed'),
      iceResetVersion: 2,
    }
    renderLanes(props)
    props = { ...props, iceConfiguration: iceConfigurationFor('late-refresh') }
    renderLanes(props)
    expect(peers('peer')).toHaveLength(2)
    expect(peers('native-video')).toHaveLength(2)
  })
})

describe('guest native receiver revival', () => {
  function startGuest() {
    const props: SignalingProps = {
      role: 'guest',
      sessionState: 'active',
      iceConfiguration: iceConfigurationFor('approved'),
      iceResetVersion: 1,
    }
    renderLanes(props)
    return { props, nativePeer: peers('native-video')[0] }
  }

  it('keeps a failed receiver that a late remote candidate revives', async () => {
    let { props, nativePeer } = startGuest()

    nativePeer.emitConnectionState('failed')
    await vi.advanceTimersByTimeAsync(500)
    nativePeer.emitConnectionState('connecting')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    expect(nativePeer.closed).toBe(false)

    // The revived attempt fails again: recovery is scheduled anew with the
    // unchanged first delay, then rebuilds only the native receiver.
    nativePeer.emitConnectionState('failed')
    await vi.advanceTimersByTimeAsync(NATIVE_UNCONNECTED_FAILURE_TOLERANCE_MS - 1)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(requestIceRefresh).toHaveBeenCalledTimes(1)
    props = { ...props, iceConfiguration: iceConfigurationFor('native-refresh') }
    renderLanes(props)
    expect(nativePeer.closed).toBe(true)
    expect(openPeers('native-video')).toHaveLength(1)
  })

  it('waits for late candidates before rebuilding a never-connected receiver', async () => {
    let { props, nativePeer } = startGuest()
    await deliverNativeOffer()

    // Only the host's private candidate arrived; the 1 s backoff would close
    // the receiver before the trickled srflx/relay candidates (~1 s later).
    nativePeer.emitConnectionState('failed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    expect(nativePeer.closed).toBe(false)

    await vi.advanceTimersByTimeAsync(NATIVE_UNCONNECTED_FAILURE_TOLERANCE_MS - 1_001)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(requestIceRefresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requestIceRefresh).toHaveBeenCalledTimes(1)

    props = { ...props, iceConfiguration: iceConfigurationFor('native-refresh') }
    renderLanes(props)
    expect(nativePeer.closed).toBe(true)
    expect(openPeers('native-video')).toHaveLength(1)
  })

  it('keeps a never-connected receiver that late candidates revive', async () => {
    const { nativePeer } = startGuest()
    await deliverNativeOffer()

    nativePeer.emitConnectionState('failed')
    await vi.advanceTimersByTimeAsync(1_050)
    nativePeer.emitConnectionState('connecting')
    nativePeer.emitConnectionState('connected')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    expect(nativePeer.closed).toBe(false)
  })

  it('keeps the regular backoff after a connected receiver drops', async () => {
    let { props, nativePeer } = startGuest()
    await deliverNativeOffer()
    nativePeer.emitConnectionState('connected')

    nativePeer.emitConnectionState('failed')
    await vi.advanceTimersByTimeAsync(999)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(requestIceRefresh).toHaveBeenCalledTimes(1)
    props = { ...props, iceConfiguration: iceConfigurationFor('native-refresh') }
    renderLanes(props)
    expect(nativePeer.closed).toBe(true)
  })

  it('restores the tolerance for each new offer', async () => {
    const { nativePeer } = startGuest()
    await deliverNativeOffer()
    nativePeer.emitConnectionState('connected')

    // The host re-offers (ICE restart) on the same receiver; the new
    // negotiation has not connected yet.
    await deliverNativeOffer()
    nativePeer.emitConnectionState('failed')
    await vi.advanceTimersByTimeAsync(NATIVE_UNCONNECTED_FAILURE_TOLERANCE_MS - 1)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(requestIceRefresh).toHaveBeenCalledTimes(1)
  })

  it('fails closed after three never-connected recoveries', async () => {
    let { props } = startGuest()

    for (const attempt of [1, 2, 3]) {
      const nativePeer = openPeers('native-video')[0]
      await deliverNativeOffer()
      nativePeer.emitConnectionState('failed')
      await vi.advanceTimersByTimeAsync(NATIVE_UNCONNECTED_FAILURE_TOLERANCE_MS - 1)
      expect(requestIceRefresh).toHaveBeenCalledTimes(attempt - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(requestIceRefresh).toHaveBeenCalledTimes(attempt)
      props = {
        ...props,
        iceConfiguration: iceConfigurationFor('native-refresh-' + attempt),
      }
      renderLanes(props)
      expect(nativePeer.closed).toBe(true)
      expect(peers('native-video')).toHaveLength(attempt + 1)
    }

    const lastPeer = openPeers('native-video')[0]
    await deliverNativeOffer()
    lastPeer.emitConnectionState('failed')
    const lanes = renderLanes(props)
    expect(lastPeer.closed).toBe(true)
    expect(lanes.native.status).toBe('failed')
    expect(lanes.native.error).toBe('Güvenli ekran görüntüsü bağlantısı kurulamadı.')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requestIceRefresh).toHaveBeenCalledTimes(3)
    expect(peers('native-video')).toHaveLength(4)
  })

  it('cancels pending recovery when the receiver reconnects', async () => {
    const { nativePeer } = startGuest()

    nativePeer.emitConnectionState('disconnected')
    nativePeer.emitConnectionState('connected')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    expect(nativePeer.closed).toBe(false)
  })
})

describe('host retry and native re-offer', () => {
  function startHost() {
    desktopBridge.desktop = true
    const props: SignalingProps = {
      role: 'host',
      sessionState: 'active',
      iceConfiguration: iceConfigurationFor('approved'),
      iceResetVersion: 1,
    }
    const lanes = renderLanes(props)
    return { props, lanes }
  }

  function openNativeNegotiation(): string {
    const negotiationId = crypto.randomUUID()
    postFromDesktop({
      type: 'desktop.native-video.negotiation',
      channel: 'native-video',
      version: 2,
      sessionEpoch: nativeStarts().at(-1)!.sessionEpoch,
      negotiationId,
      payload: {},
    })
    return negotiationId
  }

  function postNativeState(
    negotiationId: string,
    state: 'connected' | 'closed' | 'disconnected' | 'failed',
    errorCode: string | null = state === 'failed' ? 'native_video_failed' : null,
  ) {
    postFromDesktop({
      type: 'desktop.native-video.state',
      channel: 'native-video',
      version: 2,
      sessionEpoch: nativeStarts().at(-1)!.sessionEpoch,
      negotiationId,
      payload: {
        state,
        errorCode,
        recoveryAttempt: null,
        recoveryMaximumAttempts: null,
      },
    })
  }

  it('uses the fresh credential after retry-session', () => {
    let { props, lanes } = startHost()
    expect(peers('peer')).toHaveLength(1)
    expect(nativeStarts()).toHaveLength(1)

    // App.tsx retry-session: one shared refresh, both lanes wait for it.
    const awaitIceRefresh = requestIceRefresh()
    lanes.peer.retry({ awaitIceRefresh })
    lanes.native.retry({ awaitIceRefresh })
    lanes = renderLanes(props)
    expect(peers('peer')).toHaveLength(2)
    expect(nativeStarts()).toHaveLength(2)

    props = { ...props, iceConfiguration: iceConfigurationFor('retry') }
    lanes = renderLanes(props)
    expect(peers('peer')).toHaveLength(3)
    expect(openPeers('peer')).toHaveLength(1)
    expect(openPeers('peer')[0].iceServerUrl).toBe('stun:retry.example.test:3478')
    expect(nativeStarts()).toHaveLength(3)
    expect(nativeStarts().at(-1)!.iceServers)
      .toEqual([{ urls: ['stun:retry.example.test:3478'] }])

    // A retry whose refresh was not sent does not wait for a foreign answer.
    lanes.native.retry({ awaitIceRefresh: false })
    renderLanes(props)
    expect(nativeStarts()).toHaveLength(4)
    props = { ...props, iceConfiguration: iceConfigurationFor('foreign') }
    renderLanes(props)
    expect(nativeStarts()).toHaveLength(4)
    expect(peers('peer')).toHaveLength(3)
  })

  it('re-offers native video alone after the guest receiver closes', async () => {
    let { props } = startHost()
    const [generalPeer] = peers('peer')
    const negotiationId = openNativeNegotiation()
    postNativeState(negotiationId, 'connected')
    const firstEpoch = nativeStarts()[0].sessionEpoch

    // The guest rebuilt only its native receiver; WPF reports the old
    // native transport closed.
    postNativeState(negotiationId, 'closed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(requestIceRefresh).toHaveBeenCalledTimes(1)
    props = { ...props, iceConfiguration: iceConfigurationFor('native-refresh') }
    renderLanes(props)

    expect(desktopBridge.posted).toContainEqual({
      type: 'desktop.native-video.stop',
      channel: 'native-video',
      version: 2,
      sessionEpoch: firstEpoch,
    })
    expect(nativeStarts()).toHaveLength(2)
    expect(nativeStarts()[1].sessionEpoch).not.toBe(firstEpoch)
    expect(nativeStarts()[1].iceServers)
      .toEqual([{ urls: ['stun:native-refresh.example.test:3478'] }])
    expect(peers('peer')).toEqual([generalPeer])
    expect(generalPeer.closed).toBe(false)
  })

  it('leaves a failed native bridge for the user retry', async () => {
    startHost()
    postNativeState(openNativeNegotiation(), 'failed')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    expect(nativeStarts()).toHaveLength(1)
  })

  it('treats an unknown native failure code as a terminal fault', async () => {
    startHost()
    postNativeState(openNativeNegotiation(), 'failed', 'peer_gone')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    expect(nativeStarts()).toHaveLength(1)
  })

  it('re-offers native video after a native transport failure', async () => {
    let { props, lanes } = startHost()
    const [generalPeer] = peers('peer')
    const firstEpoch = nativeStarts()[0].sessionEpoch

    postNativeState(openNativeNegotiation(), 'failed', 'native_transport_failed')
    lanes = renderLanes(props)
    expect(lanes.native.status).toBe('disconnected')
    expect(lanes.native.error)
      .toBe('Ekran görüntüsü bağlantısı kesildi; yeniden bağlanılıyor.')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(requestIceRefresh).toHaveBeenCalledTimes(1)
    props = { ...props, iceConfiguration: iceConfigurationFor('native-refresh') }
    lanes = renderLanes(props)

    expect(desktopBridge.posted).toContainEqual({
      type: 'desktop.native-video.stop',
      channel: 'native-video',
      version: 2,
      sessionEpoch: firstEpoch,
    })
    expect(nativeStarts()).toHaveLength(2)
    expect(nativeStarts()[1].iceServers)
      .toEqual([{ urls: ['stun:native-refresh.example.test:3478'] }])
    expect(lanes.native.status).toBe('connecting')
    expect(peers('peer')).toEqual([generalPeer])
    expect(generalPeer.closed).toBe(false)
  })

  it('stops for the user retry after three native transport recoveries', async () => {
    let { props, lanes } = startHost()

    for (const [attempt, delay] of [[1, 1_000], [2, 2_000], [3, 4_000]]) {
      postNativeState(openNativeNegotiation(), 'failed', 'native_transport_failed')
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(requestIceRefresh).toHaveBeenCalledTimes(attempt - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(requestIceRefresh).toHaveBeenCalledTimes(attempt)
      props = {
        ...props,
        iceConfiguration: iceConfigurationFor('native-refresh-' + attempt),
      }
      renderLanes(props)
      expect(nativeStarts()).toHaveLength(attempt + 1)
    }

    const lastEpoch = nativeStarts().at(-1)!.sessionEpoch
    postNativeState(openNativeNegotiation(), 'failed', 'native_transport_failed')
    lanes = renderLanes(props)
    expect(lanes.native.status).toBe('failed')
    expect(lanes.native.error).toBe('Güvenli ekran görüntüsü bağlantısı kurulamadı.')
    expect(desktopBridge.posted).toContainEqual({
      type: 'desktop.native-video.stop',
      channel: 'native-video',
      version: 2,
      sessionEpoch: lastEpoch,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestIceRefresh).toHaveBeenCalledTimes(3)
    expect(nativeStarts()).toHaveLength(4)

    // Only the user's retry clears the latch and starts a new attempt budget.
    lanes.native.retry()
    lanes = renderLanes(props)
    expect(nativeStarts()).toHaveLength(5)
    expect(lanes.native.status).toBe('connecting')
  })

  it('keeps a healthy native stream after a transient disconnect', async () => {
    startHost()
    const negotiationId = openNativeNegotiation()
    postNativeState(negotiationId, 'connected')

    postNativeState(negotiationId, 'disconnected')
    await vi.advanceTimersByTimeAsync(500)
    postNativeState(negotiationId, 'connected')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestIceRefresh).not.toHaveBeenCalled()
    expect(nativeStarts()).toHaveLength(1)
    expect(desktopBridge.posted.some(
      (message) => message.type === 'desktop.native-video.stop',
    )).toBe(false)
  })
})
