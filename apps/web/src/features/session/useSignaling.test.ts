import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hookRuntime = vi.hoisted(() => {
  let slots: unknown[] = []
  let cursor = 0
  let pendingEffects: Array<() => void | (() => void)> = []
  let cleanups: Array<() => void> = []

  function nextSlot() {
    const slot = cursor
    cursor += 1
    return slot
  }

  return {
    beginRender() {
      cursor = 0
      pendingEffects = []
    },
    flushEffects() {
      for (const effect of pendingEffects) {
        const cleanup = effect()
        if (cleanup) cleanups.push(cleanup)
      }
      pendingEffects = []
    },
    reset() {
      for (const cleanup of cleanups.splice(0)) cleanup()
      slots = []
      cursor = 0
      pendingEffects = []
    },
    useCallback<T>(callback: T) {
      nextSlot()
      return callback
    },
    useEffect(effect: () => void | (() => void)) {
      nextSlot()
      pendingEffects.push(effect)
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
        slots[slot] =
          typeof nextValue === 'function'
            ? (nextValue as (current: T) => T)(slots[slot] as T)
            : nextValue
      }
      return [slots[slot] as T, setValue] as const
    },
  }
})

vi.mock('react', () => ({
  useCallback: hookRuntime.useCallback,
  useEffect: hookRuntime.useEffect,
  useRef: hookRuntime.useRef,
  useState: hookRuntime.useState,
}))

vi.mock('../desktop/useDesktopBridge', () => ({
  getRuntimeConfiguration: () => ({ signalingUrl: 'ws://signaling.test/ws' }),
}))

import { useSignaling } from './useSignaling'
import { SIGNALING_SUBPROTOCOL } from '@ediz-remote/protocol'

type WebSocketListener = (event: { data?: string }) => void

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: MockWebSocket[] = []

  readonly url: string
  readonly protocols?: string | string[]
  readonly sent: string[] = []
  readyState = MockWebSocket.CONNECTING
  private readonly listeners = new Map<string, Set<WebSocketListener>>()

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: WebSocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<WebSocketListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  send(value: string) {
    this.sent.push(value)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.emit('open')
  }

  disconnect() {
    this.readyState = MockWebSocket.CLOSED
    this.emit('close')
  }

  message(value: unknown) {
    this.emit('message', { data: JSON.stringify(value) })
  }

  private emit(type: string, event: { data?: string } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const clientId = '11111111-1111-4111-8111-111111111111'
const peerId = '22222222-2222-4222-8222-222222222222'
const requestId = '33333333-3333-4333-8333-333333333333'
const expiry = '2026-08-24T00:00:00.000Z'
const resumeToken = 'a'.repeat(32)
const iceConfiguration = {
  version: 1 as const,
  expiresAt: null,
  iceServers: [{ urls: ['stun:stun.example.test'] }],
}

function useRenderSignaling(runEffects = false) {
  hookRuntime.beginRender()
  const result = useSignaling()
  if (runEffects) hookRuntime.flushEffects()
  return result
}

function deliverReady(socket: MockWebSocket) {
  socket.open()
  socket.message({
    type: 'ready',
    clientId,
    protocolVersion: 3,
    minimumProtocolVersion: 3,
  })
}

function deliverSessionCreated(socket: MockWebSocket, code: string) {
  socket.message({ type: 'session_created', code, expiresAt: expiry })
}

beforeEach(() => {
  vi.useFakeTimers()
  hookRuntime.reset()
  MockWebSocket.instances.length = 0
  const windowListeners = new Map<string, Set<() => void>>()
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    addEventListener(type: string, listener: () => void) {
      const listeners = windowListeners.get(type) ?? new Set<() => void>()
      listeners.add(listener)
      windowListeners.set(type, listeners)
    },
    removeEventListener(type: string, listener: () => void) {
      windowListeners.get(type)?.delete(listener)
    },
  })
  vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
  hookRuntime.reset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('signaling socket lifecycle', () => {
  it('requests the mandatory versioned WebSocket subprotocol', () => {
    useRenderSignaling(true)

    expect(MockWebSocket.instances[0]?.protocols).toBe(SIGNALING_SUBPROTOCOL)
  })

  it('ignores callbacks from an older WebSocket generation', async () => {
    useRenderSignaling(true)
    const first = MockWebSocket.instances[0]
    deliverReady(first)
    deliverSessionCreated(first, '111111')

    first.disconnect()
    await vi.advanceTimersByTimeAsync(1_000)

    const second = MockWebSocket.instances[1]
    deliverReady(second)
    deliverSessionCreated(second, '222222')
    deliverSessionCreated(first, '999999')

    const current = useRenderSignaling()
    expect(current.sessionState).toBe('waiting')
    expect(current.sessionRole).toBe('host')
    expect(current.sessionCode).toBe('222222')
  })

  it('keeps terminal sessions blocked until an explicit new-session action', () => {
    useRenderSignaling(true)
    const socket = MockWebSocket.instances[0]
    deliverReady(socket)
    deliverSessionCreated(socket, '111111')

    socket.message({ type: 'session_ended', reason: 'host_left' })
    deliverSessionCreated(socket, '999999')

    const ended = useRenderSignaling()
    expect(ended.sessionState).toBe('idle')
    expect(ended.sessionCode).toBeNull()
    expect(ended.errorCode).toBe('session_ended')

    ended.createSession()
    deliverSessionCreated(socket, '222222')

    const restarted = useRenderSignaling()
    expect(restarted.sessionState).toBe('waiting')
    expect(restarted.sessionCode).toBe('222222')
    expect(restarted.errorCode).toBeNull()
  })

  it('ignores late create and join replies from superseded user actions', () => {
    const initial = useRenderSignaling(true)
    const socket = MockWebSocket.instances[0]
    deliverReady(socket)

    initial.joinSession('222222')
    deliverSessionCreated(socket, '111111')
    socket.message({ type: 'join_pending', code: '222222', requestId })

    const joining = useRenderSignaling()
    expect(joining.sessionState).toBe('joining')
    expect(joining.sessionRole).toBe('guest')
    expect(joining.errorCode).toBeNull()
    expect(socket.readyState).toBe(MockWebSocket.OPEN)

    joining.createSession()
    socket.message({ type: 'join_pending', code: '222222', requestId })
    deliverSessionCreated(socket, '333333')

    const waiting = useRenderSignaling()
    expect(waiting.sessionState).toBe('waiting')
    expect(waiting.sessionRole).toBe('host')
    expect(waiting.sessionCode).toBe('333333')
    expect(waiting.errorCode).toBeNull()
    expect(socket.readyState).toBe(MockWebSocket.OPEN)
  })

  it('ignores a duplicate create reply without terminating the active socket', () => {
    useRenderSignaling(true)
    const socket = MockWebSocket.instances[0]
    deliverReady(socket)
    deliverSessionCreated(socket, '111111')
    deliverSessionCreated(socket, '999999')

    const current = useRenderSignaling()
    expect(current.sessionState).toBe('waiting')
    expect(current.sessionCode).toBe('111111')
    expect(current.errorCode).toBeNull()
    expect(socket.readyState).toBe(MockWebSocket.OPEN)
  })

  it('coalesces duplicate create actions while the first reply is pending', () => {
    useRenderSignaling(true)
    const socket = MockWebSocket.instances[0]
    deliverReady(socket)
    deliverSessionCreated(socket, '111111')

    const waiting = useRenderSignaling()
    const createsBefore = socket.sent.filter(
      (value) => JSON.parse(value).type === 'create_session',
    ).length
    waiting.createSession()
    waiting.createSession()
    const createsAfter = socket.sent.filter(
      (value) => JSON.parse(value).type === 'create_session',
    ).length

    expect(createsAfter - createsBefore).toBe(1)
    deliverSessionCreated(socket, '222222')
    expect(useRenderSignaling().sessionCode).toBe('222222')
  })

  it('keeps approved control through peer-unavailable retry and peer resume', () => {
    useRenderSignaling(true)
    const socket = MockWebSocket.instances[0]
    deliverReady(socket)
    deliverSessionCreated(socket, '111111')
    socket.message({
      type: 'peer_joined',
      peerId,
      accessMode: 'control',
      iceConfiguration,
      resumeToken,
      reconnectGraceSeconds: 30,
    })

    socket.message({
      type: 'error',
      code: 'peer_unavailable',
      message: 'Peer unavailable',
    })

    const recovering = useRenderSignaling()
    expect(recovering.sessionState).toBe('recovering')
    expect(recovering.accessMode).toBe('control')

    recovering.retryConnection()
    const retrying = useRenderSignaling()
    expect(retrying.sessionState).toBe('recovering')
    expect(retrying.accessMode).toBe('control')

    socket.message({ type: 'peer_resumed', peerId, iceConfiguration })
    const resumed = useRenderSignaling()
    expect(resumed.sessionState).toBe('active')
    expect(resumed.accessMode).toBe('control')
    expect(resumed.errorCode).toBeNull()
  })

  it('resets every negotiation lane only on approval and resume', () => {
    useRenderSignaling(true)
    const socket = MockWebSocket.instances[0]
    deliverReady(socket)
    deliverSessionCreated(socket, '111111')
    expect(useRenderSignaling().iceResetVersion).toBe(0)
    socket.message({
      type: 'peer_joined',
      peerId,
      accessMode: 'control',
      iceConfiguration,
      resumeToken,
      reconnectGraceSeconds: 30,
    })
    const joined = useRenderSignaling()
    expect(joined.iceResetVersion).toBe(1)

    // A lane's own refresh answer replaces the configuration only.
    const refreshed = { ...iceConfiguration, iceServers: [{ urls: ['stun:fresh.example.test'] }] }
    socket.message({ type: 'ice_configuration', iceConfiguration: refreshed })
    const afterRefresh = useRenderSignaling()
    expect(afterRefresh.iceConfiguration).toEqual(refreshed)
    expect(afterRefresh.iceResetVersion).toBe(1)

    socket.message({ type: 'peer_suspended', reconnectUntil: expiry })
    expect(useRenderSignaling().iceResetVersion).toBe(1)
    socket.message({ type: 'peer_resumed', peerId, iceConfiguration })
    const resumed = useRenderSignaling()
    expect(resumed.sessionState).toBe('active')
    expect(resumed.iceResetVersion).toBe(2)
  })

  it('clears a throttled create latch so the user can request a new code', () => {
    const initial = useRenderSignaling(true)
    const socket = MockWebSocket.instances[0]
    deliverReady(socket)
    const createsBefore = socket.sent.filter(
      (value) => JSON.parse(value).type === 'create_session',
    ).length

    socket.message({
      type: 'error',
      code: 'rate_limited',
      message: 'Wait',
      operation: 'create_session',
      retryAfterSeconds: 15,
    })
    const limited = useRenderSignaling()
    expect(limited.sessionState).toBe('idle')
    expect(limited.sessionRole).toBe('host')
    expect(limited.errorCode).toBe('rate_limited')

    limited.createSession()
    const createsAfter = socket.sent.filter(
      (value) => JSON.parse(value).type === 'create_session',
    ).length
    expect(createsAfter).toBe(createsBefore + 1)
    deliverSessionCreated(socket, '222222')
    expect(useRenderSignaling().sessionCode).toBe('222222')
    expect(initial.sessionCode).toBeNull()
  })

  it('automatically retries a throttled resume on a fresh socket', async () => {
    useRenderSignaling(true)
    const first = MockWebSocket.instances[0]
    deliverReady(first)
    deliverSessionCreated(first, '111111')
    first.message({
      type: 'peer_joined',
      peerId,
      accessMode: 'control',
      iceConfiguration,
      resumeToken,
      reconnectGraceSeconds: 30,
    })

    first.disconnect()
    await vi.advanceTimersByTimeAsync(1_000)
    const second = MockWebSocket.instances[1]
    deliverReady(second)
    expect(JSON.parse(second.sent.at(-1) ?? '{}')).toEqual({
      type: 'resume_session',
      token: resumeToken,
    })

    second.message({
      type: 'error',
      code: 'rate_limited',
      message: 'Wait',
      operation: 'resume_session',
      retryAfterSeconds: 2,
    })
    expect(useRenderSignaling().sessionState).toBe('recovering')

    await vi.advanceTimersByTimeAsync(1_999)
    expect(MockWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)

    const third = MockWebSocket.instances[2]
    expect(third).toBeDefined()
    expect(second.readyState).toBe(MockWebSocket.CLOSED)
    deliverReady(third)
    expect(JSON.parse(third.sent.at(-1) ?? '{}')).toEqual({
      type: 'resume_session',
      token: resumeToken,
    })
    expect(useRenderSignaling().accessMode).toBe('control')
  })

  it('keeps an approved session active and refreshes ICE after signal throttling', async () => {
    useRenderSignaling(true)
    const socket = MockWebSocket.instances[0]
    deliverReady(socket)
    deliverSessionCreated(socket, '111111')
    socket.message({
      type: 'peer_joined',
      peerId,
      accessMode: 'control',
      iceConfiguration,
      resumeToken,
      reconnectGraceSeconds: 30,
    })

    socket.message({
      type: 'error',
      code: 'rate_limited',
      message: 'Wait',
      operation: 'signal',
      retryAfterSeconds: 1,
    })
    const limited = useRenderSignaling()
    expect(limited.sessionState).toBe('active')
    expect(limited.accessMode).toBe('control')
    expect(limited.errorCode).toBe('rate_limited')

    const refreshesBefore = socket.sent.filter(
      (value) => JSON.parse(value).type === 'refresh_ice',
    ).length
    await vi.advanceTimersByTimeAsync(999)
    expect(
      socket.sent.filter((value) => JSON.parse(value).type === 'refresh_ice'),
    ).toHaveLength(refreshesBefore)
    await vi.advanceTimersByTimeAsync(1)
    expect(
      socket.sent.filter((value) => JSON.parse(value).type === 'refresh_ice'),
    ).toHaveLength(refreshesBefore + 1)
    expect(useRenderSignaling().errorCode).toBeNull()

    socket.message({ type: 'peer_suspended', reconnectUntil: expiry })
    const recovering = useRenderSignaling()
    expect(recovering.sessionState).toBe('recovering')
    expect(recovering.accessMode).toBe('control')
  })

  it('resumes on a fresh socket when a guest answer is throttled', async () => {
    const initial = useRenderSignaling(true)
    const first = MockWebSocket.instances[0]
    deliverReady(first)
    initial.joinSession('111111')
    first.message({ type: 'join_pending', code: '111111', requestId })
    first.message({
      type: 'session_approved',
      code: '111111',
      peerId,
      accessMode: 'control',
      iceConfiguration,
      resumeToken,
      reconnectGraceSeconds: 30,
    })
    expect(useRenderSignaling().sessionRole).toBe('guest')

    first.message({
      type: 'error',
      code: 'rate_limited',
      message: 'Wait',
      operation: 'signal',
      retryAfterSeconds: 1,
    })
    await vi.advanceTimersByTimeAsync(1_000)

    const second = MockWebSocket.instances[1]
    expect(second).toBeDefined()
    expect(first.readyState).toBe(MockWebSocket.CLOSED)
    expect(useRenderSignaling().sessionState).toBe('recovering')
    deliverReady(second)
    expect(JSON.parse(second.sent.at(-1) ?? '{}')).toEqual({
      type: 'resume_session',
      token: resumeToken,
    })
    expect(useRenderSignaling().accessMode).toBe('control')
  })

  it('revokes control locally and persists the downgrade through signaling', () => {
    useRenderSignaling(true)
    const socket = MockWebSocket.instances[0]
    deliverReady(socket)
    deliverSessionCreated(socket, '111111')
    socket.message({
      type: 'peer_joined',
      peerId,
      accessMode: 'control',
      iceConfiguration,
      resumeToken,
      reconnectGraceSeconds: 30,
    })

    const active = useRenderSignaling()
    active.revokeControl()

    const revoked = useRenderSignaling()
    expect(revoked.accessMode).toBe('view')
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({
      type: 'revoke_control',
      channel: 'control',
      version: 1,
    })

    socket.message({
      type: 'peer_suspended',
      reconnectUntil: expiry,
    })
    socket.message({
      type: 'session_resumed',
      role: 'host',
      code: '111111',
      peerId,
      accessMode: 'control',
      resumeToken: 'b'.repeat(32),
      peerConnected: true,
      reconnectGraceSeconds: 30,
      iceConfiguration,
    })

    const resumed = useRenderSignaling()
    expect(resumed.sessionState).toBe('active')
    expect(resumed.accessMode).toBe('view')
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({
      type: 'revoke_control',
      channel: 'control',
      version: 1,
    })
  })

  it('keeps early bare and native signals in separate bounded lanes', () => {
    useRenderSignaling(true)
    const socket = MockWebSocket.instances[0]
    deliverReady(socket)
    deliverSessionCreated(socket, '111111')
    socket.message({
      type: 'peer_joined',
      peerId,
      accessMode: 'view',
      iceConfiguration,
      resumeToken,
      reconnectGraceSeconds: 30,
    })

    const bareSignal = {
      kind: 'session-description',
      negotiationId: '11111111-1111-4111-8111-111111111111',
      description: { type: 'offer', sdp: 'bare-offer' },
    }
    const nativeSignal = {
      channel: 'native-video',
      version: 2,
      signal: {
        kind: 'session-description',
        negotiationId: '22222222-2222-4222-8222-222222222222',
        description: { type: 'offer', sdp: 'native-offer' },
      },
    }
    socket.message({ type: 'signal', from: peerId, payload: bareSignal })
    socket.message({ type: 'signal', from: peerId, payload: nativeSignal })

    const active = useRenderSignaling()
    const nativeReceived: unknown[] = []
    const bareReceived: unknown[] = []
    active.subscribeToSignals('native-video', (payload) => nativeReceived.push(payload))
    expect(nativeReceived).toEqual([nativeSignal])
    expect(bareReceived).toEqual([])
    active.subscribeToSignals('peer', (payload) => bareReceived.push(payload))
    expect(bareReceived).toEqual([bareSignal])
  })
})
