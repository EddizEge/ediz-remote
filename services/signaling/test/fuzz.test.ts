import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  MAX_SIGNALING_MESSAGE_BYTES,
  SIGNALING_SUBPROTOCOL,
  clientMessageSchema,
  serverMessageSchema,
  type ServerMessage,
  type SignalingPayload,
} from '@ediz-remote/protocol'
import {
  createSignalingServer,
  type SignalingSecurityOptions,
  type SignalingServer,
  type SignalingServerOptions,
} from '../src/server.js'
import {
  SeededRandom,
  canonicalJson,
  mutateJson,
  randomJsonValue,
  randomString,
  type JsonValue,
} from '../../../packages/protocol/test/fuzzSupport.js'

// Sabit seed'li canlı sunucu fuzz'ı. Sunucu aynı süreçte çalışır: handler'dan
// kaçan bir istisna vitest'te işlenmemiş hata olarak koşuyu düşürür ve prototip
// kirlenmesi doğrudan bu süreçte görünür.
const FUZZ_SEED = 0x5349_474e
const UNBOUND_FRAMES = 2_500
const APPROVED_ROUNDS = 6
const APPROVED_FRAMES_PER_ROUND = 350
const ABUSE_FRAMES = 240
const POLLUTION_MARKER = 'edizRemoteFuzzPolluted'

const GENEROUS_BUCKET = { capacity: 1_000_000, refillPerSecond: 1_000_000 }
const GENEROUS_BYTES = { capacity: 1_000_000_000, refillPerSecond: 1_000_000_000 }
const generousSecurity: SignalingSecurityOptions = {
  maxSessions: 4_096,
  maxSessionsPerIp: 4_096,
  globalInboundMessages: GENEROUS_BUCKET,
  globalInboundBytes: GENEROUS_BYTES,
  inboundMessages: GENEROUS_BUCKET,
  inboundBytes: GENEROUS_BYTES,
  globalCreateSession: GENEROUS_BUCKET,
  createSession: GENEROUS_BUCKET,
  globalJoinSession: GENEROUS_BUCKET,
  joinSession: GENEROUS_BUCKET,
  globalResumeSession: GENEROUS_BUCKET,
  resumeSession: GENEROUS_BUCKET,
  globalInvalidMessage: GENEROUS_BUCKET,
  invalidSocketMessage: GENEROUS_BUCKET,
  invalidMessage: GENEROUS_BUCKET,
  globalRefreshIce: GENEROUS_BUCKET,
  refreshIce: GENEROUS_BUCKET,
  globalSignalMessages: GENEROUS_BUCKET,
  signalMessages: GENEROUS_BUCKET,
  globalSignalBytes: GENEROUS_BYTES,
  signalBytes: GENEROUS_BYTES,
}

const runningServers: SignalingServer[] = []
const openSockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate()
  await Promise.all(runningServers.splice(0).map((server) => server.stop()))
})

interface FuzzClient {
  socket: WebSocket
  clientId: string
  received: ServerMessage[]
  invalidFrames: string[]
  ping(): Promise<boolean>
  waitFor<T extends ServerMessage['type']>(
    type: T,
    fromIndex?: number,
  ): Promise<Extract<ServerMessage, { type: T }> | null>
}

async function startServer(options: SignalingServerOptions = {}) {
  const server = createSignalingServer({
    ...options,
    port: 0,
    host: '127.0.0.1',
    staticDir: null,
  })
  runningServers.push(server)
  const port = await server.start()
  return { port, url: `ws://127.0.0.1:${port}/ws` }
}

async function openClient(url: string): Promise<FuzzClient> {
  const socket = new WebSocket(url, SIGNALING_SUBPROTOCOL, { origin: webSocketOrigin(url) })
  openSockets.push(socket)
  const received: ServerMessage[] = []
  const invalidFrames: string[] = []
  const listeners = new Set<() => void>()
  let closed = false

  socket.on('error', () => undefined)
  socket.on('close', () => {
    closed = true
    for (const listener of listeners) listener()
  })
  socket.on('message', (data, isBinary) => {
    const text = data.toString()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      invalidFrames.push(text.slice(0, 200))
      return
    }
    const result = serverMessageSchema.safeParse(parsed)
    if (isBinary || !result.success) {
      invalidFrames.push(text.slice(0, 200))
      return
    }
    received.push(result.data)
    for (const listener of listeners) listener()
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  const waitFor = <T extends ServerMessage['type']>(type: T, fromIndex = 0) =>
    new Promise<Extract<ServerMessage, { type: T }> | null>((resolve) => {
      const check = () => {
        const match = received
          .slice(fromIndex)
          .find((message) => message.type === type)
        if (match) {
          finish(match as Extract<ServerMessage, { type: T }>)
        } else if (closed) {
          finish(null)
        }
      }
      const timer = setTimeout(() => finish(null), 2_000)
      const finish = (value: Extract<ServerMessage, { type: T }> | null) => {
        clearTimeout(timer)
        listeners.delete(check)
        resolve(value)
      }
      listeners.add(check)
      check()
    })

  const ready = await waitFor('ready')
  if (!ready) throw new Error('ready mesajı alınamadı')

  return {
    socket,
    clientId: ready.clientId,
    received,
    invalidFrames,
    waitFor,
    async ping() {
      if (socket.readyState !== WebSocket.OPEN) return false
      const fromIndex = received.length
      socket.send(JSON.stringify({ type: 'ping' }))
      return (await waitFor('pong', fromIndex)) !== null
    },
  }
}

async function approvedPair(url: string) {
  const host = await openClient(url)
  const guest = await openClient(url)
  host.socket.send(JSON.stringify({ type: 'create_session' }))
  const created = await host.waitFor('session_created')
  if (!created) throw new Error('session_created alınamadı')
  guest.socket.send(JSON.stringify({ type: 'join_session', code: created.code }))
  const incoming = await host.waitFor('incoming_request')
  if (!incoming) throw new Error('incoming_request alınamadı')
  host.socket.send(
    JSON.stringify({
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'control',
    }),
  )
  const [approved, joined] = await Promise.all([
    guest.waitFor('session_approved'),
    host.waitFor('peer_joined'),
  ])
  if (!approved || !joined) throw new Error('oturum onaylanamadı')
  return { host, guest }
}

async function expectHealthy(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/health`)
  expect(response.status).toBe(200)
  const body = (await response.json()) as { status: string; sessions: number }
  expect(body.status).toBe('ok')
  expect(Number.isInteger(body.sessions)).toBe(true)
}

async function expectValidRelay(url: string): Promise<void> {
  const { host, guest } = await approvedPair(url)
  const payload: SignalingPayload = {
    kind: 'session-description',
    negotiationId: negotiationIdForIndex(0xfeed),
    description: { type: 'offer', sdp: 'v=0\r\n' },
  }
  const fromIndex = guest.received.length
  host.socket.send(JSON.stringify({ type: 'signal', payload }))
  const relayed = await guest.waitFor('signal', fromIndex)
  expect(relayed?.payload).toEqual(payload)
  host.socket.close()
  guest.socket.close()
}

function negotiationIdForIndex(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

function offerPayload(negotiationId: string): JsonValue {
  return {
    kind: 'session-description',
    negotiationId,
    description: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' },
  }
}

function answerPayload(negotiationId: string): JsonValue {
  return {
    kind: 'session-description',
    negotiationId,
    description: { type: 'answer', sdp: 'v=0\r\n' },
  }
}

function candidatePayload(negotiationId: string): JsonValue {
  return {
    kind: 'ice-candidate',
    negotiationId,
    candidate: {
      candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    },
  }
}

function nativePayload(signal: JsonValue): JsonValue {
  return { channel: 'native-video', version: 2, signal }
}

const UNBOUND_SEEDS: JsonValue[] = [
  { type: 'create_session' },
  { type: 'join_session', code: '123456' },
  {
    type: 'request_decision',
    requestId: '19f3d8f5-2af5-4e77-a155-41e60d94c1b2',
    approved: true,
    accessMode: 'control',
  },
  {
    type: 'request_decision',
    requestId: '19f3d8f5-2af5-4e77-a155-41e60d94c1b2',
    approved: false,
  },
  { type: 'signal', payload: offerPayload(negotiationIdForIndex(1)) },
  { type: 'signal', payload: answerPayload(negotiationIdForIndex(1)) },
  { type: 'signal', payload: candidatePayload(negotiationIdForIndex(1)) },
  { type: 'signal', payload: nativePayload(offerPayload(negotiationIdForIndex(2))) },
  { type: 'resume_session', token: 'A'.repeat(43) },
  { type: 'refresh_ice' },
  { type: 'revoke_control', channel: 'control', version: 1 },
  { type: 'leave_session' },
  { type: 'ping' },
]

const PROTOTYPE_FRAMES = [
  `{"type":"ping","__proto__":{"${POLLUTION_MARKER}":true}}`,
  `{"__proto__":{"${POLLUTION_MARKER}":true},"type":"create_session"}`,
  `{"type":"signal","payload":{"kind":"ice-candidate","negotiationId":"${negotiationIdForIndex(3)}",` +
    `"candidate":{"candidate":"x","__proto__":{"${POLLUTION_MARKER}":true}}}}`,
  `{"type":"join_session","code":"123456","constructor":{"prototype":{"${POLLUTION_MARKER}":true}}}`,
  `{"type":"signal","payload":{"channel":"native-video","version":2,"signal":{"__proto__":` +
    `{"${POLLUTION_MARKER}":true},"kind":"ice-candidate","negotiationId":"${negotiationIdForIndex(4)}",` +
    `"candidate":{"candidate":"x"}}}}`,
]

const FIXED_GARBAGE = [
  '',
  ' ',
  'null',
  'true',
  '0',
  '[]',
  '{}',
  '"ping"',
  '{"type":null}',
  '{"type":"ping"',
  '{"type":"ping"}{"type":"ping"}',
  '\u0000',
  '{"type":"\\ud800"}',
  '{"type":"ping","type":"create_session"}',
] as const

interface FuzzFrame {
  data: string | Buffer
  binary: boolean
  closesSocket: boolean
}

function nextUnboundFrame(random: SeededRandom): FuzzFrame {
  const text = (data: string): FuzzFrame => ({ data, binary: false, closesSocket: false })
  const roll = random.integer(100)
  if (roll < 35) return text(JSON.stringify(mutateJson(random, random.pick(UNBOUND_SEEDS))))
  if (roll < 55) return text(JSON.stringify(randomJsonValue(random)))
  if (roll < 63) return text(JSON.stringify(random.pick(UNBOUND_SEEDS)))
  if (roll < 75) {
    const seed = JSON.stringify(random.pick(UNBOUND_SEEDS))
    switch (random.integer(4)) {
      case 0:
        return text(seed.slice(0, random.integer(seed.length)))
      case 1:
        return text(seed + randomString(random))
      case 2:
        return text(random.pick(FIXED_GARBAGE))
      default:
        return text(randomString(random))
    }
  }
  if (roll < 80) {
    return {
      data: Buffer.from(JSON.stringify(random.pick(UNBOUND_SEEDS))),
      binary: true,
      closesSocket: false,
    }
  }
  if (roll < 86) return text(random.pick(PROTOTYPE_FRAMES))
  if (roll < 91) {
    const depth = 1_000 + random.integer(9_000)
    return text(`{"type":"signal","payload":${'['.repeat(depth)}${']'.repeat(depth)}}`)
  }
  if (roll < 95) {
    return text(`{"type":"signal","payload":[${'{},'.repeat(9_000)}{}]}`)
  }
  if (roll < 98) {
    return { data: Buffer.from([0xc3, 0x28, 0xff]), binary: false, closesSocket: true }
  }
  return { data: 'x'.repeat(MAX_SIGNALING_MESSAGE_BYTES + 1), binary: false, closesSocket: true }
}

function polluted(): unknown {
  return (Object.prototype as Record<string, unknown>)[POLLUTION_MARKER]
}

function descriptionType(payload: SignalingPayload): 'offer' | 'answer' | null {
  const signal = 'channel' in payload ? payload.signal : payload
  return signal.kind === 'session-description' ? signal.description.type : null
}

describe('signaling server fuzz matrix', () => {
  it('survives an unauthenticated fuzz campaign without relaying or approving anything', async () => {
    const { port, url } = await startServer({ security: generousSecurity })
    const random = new SeededRandom(FUZZ_SEED)
    const clients: FuzzClient[] = []
    let client = await openClient(url)
    clients.push(client)

    for (let iteration = 0; iteration < UNBOUND_FRAMES; iteration += 1) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        client = await openClient(url)
        clients.push(client)
      }
      const frame = nextUnboundFrame(random)
      client.socket.send(frame.data, { binary: frame.binary })
      if (frame.closesSocket || iteration % 50 === 49) {
        const alive = await client.ping()
        if (!alive) {
          expect(client.socket.readyState, `iteration=${iteration}`).not.toBe(WebSocket.OPEN)
        }
      }
    }

    const coverage = { invalidMessage: 0, notAuthorized: 0, created: 0, pong: 0 }
    for (const fuzzClient of clients) {
      expect(fuzzClient.invalidFrames).toEqual([])
      const forbidden = fuzzClient.received.filter((message) =>
        ['signal', 'session_approved', 'peer_joined', 'session_resumed'].includes(
          message.type,
        ),
      )
      expect(forbidden).toEqual([])
      for (const message of fuzzClient.received) {
        if (message.type === 'error' && message.code === 'invalid_message') {
          coverage.invalidMessage += 1
        }
        if (message.type === 'error' && message.code === 'not_authorized') {
          coverage.notAuthorized += 1
        }
        if (message.type === 'session_created') coverage.created += 1
        if (message.type === 'pong') coverage.pong += 1
      }
    }
    console.info('unbound fuzz coverage', { ...coverage, sockets: clients.length })
    // Boş geçen bir kampanya değişmezleri kanıtlamaz; ana yolların gerçekten
    // çalıştığı alt sınırlarla doğrulanır.
    expect(clients.length).toBeGreaterThan(10)
    expect(coverage.invalidMessage).toBeGreaterThan(UNBOUND_FRAMES / 4)
    expect(coverage.notAuthorized).toBeGreaterThan(10)
    expect(coverage.created).toBeGreaterThan(5)
    expect(polluted()).toBeUndefined()
    await expectHealthy(port)
    await expectValidRelay(url)
  }, 60_000)

  it('relays only exact, direction-correct payloads while both members send mutated traffic', async () => {
    const { port, url } = await startServer({ security: generousSecurity })
    const random = new SeededRandom(FUZZ_SEED ^ 0xa11)
    let negotiationCounter = 0x100
    const coverage = { relayedToGuest: 0, relayedToHost: 0, rejected: 0 }

    for (let round = 0; round < APPROVED_ROUNDS; round += 1) {
      const { host, guest } = await approvedPair(url)
      const sentBy = { host: new Set<string>(), guest: new Set<string>() }
      let currentPeerId = negotiationIdForIndex(negotiationCounter)
      let currentNativeId = negotiationIdForIndex(negotiationCounter + 1)

      for (let iteration = 0; iteration < APPROVED_FRAMES_PER_ROUND; iteration += 1) {
        const role = random.chance(0.5) ? 'host' : 'guest'
        const sender = role === 'host' ? host : guest
        if (sender.socket.readyState !== WebSocket.OPEN) continue
        let value: JsonValue
        if (role === 'host' && random.chance(0.15)) {
          // Değiştirilmemiş yeni offer sunucunun güncel kimliğini ilerletir; misafir
          // answer/candidate'ları ancak bu kimlikte relay edilebilir. İki soket ayrı
          // TCP akışı olduğundan offer'ın önü ve arkası ping ile sıralanır.
          negotiationCounter += 1
          const negotiationId = negotiationIdForIndex(negotiationCounter)
          await guest.ping()
          if (random.chance(0.5)) {
            currentPeerId = negotiationId
            value = { type: 'signal', payload: offerPayload(negotiationId) }
          } else {
            currentNativeId = negotiationId
            value = { type: 'signal', payload: nativePayload(offerPayload(negotiationId)) }
          }
          const offerFrame = JSON.stringify(value)
          sentBy.host.add(canonicalJson((value as { payload: JsonValue }).payload))
          host.socket.send(offerFrame)
          await host.ping()
          continue
        } else {
          const seeds: JsonValue[] =
            role === 'host'
              ? [
                  { type: 'signal', payload: offerPayload(currentPeerId) },
                  { type: 'signal', payload: candidatePayload(currentPeerId) },
                  { type: 'signal', payload: nativePayload(candidatePayload(currentNativeId)) },
                  { type: 'refresh_ice' },
                  { type: 'revoke_control', channel: 'control', version: 1 },
                  { type: 'ping' },
                ]
              : [
                  { type: 'signal', payload: answerPayload(currentPeerId) },
                  { type: 'signal', payload: candidatePayload(currentPeerId) },
                  { type: 'signal', payload: nativePayload(answerPayload(currentNativeId)) },
                  { type: 'signal', payload: nativePayload(candidatePayload(currentNativeId)) },
                  { type: 'refresh_ice' },
                  { type: 'ping' },
                ]
          const seed = random.pick(seeds)
          value = random.chance(0.45) ? seed : mutateJson(random, seed)
        }
        const frame = JSON.stringify(value)
        const parsed = clientMessageSchema.safeParse(JSON.parse(frame))
        if (parsed.success && parsed.data.type === 'signal') {
          sentBy[role].add(canonicalJson(parsed.data.payload))
        }
        sender.socket.send(frame)
      }

      // Sıra garantisi: göndericinin pong'u relay yazımından sonra gelir; alıcının
      // sonraki pong'u da aynı TCP akışında relay'den sonra okunur.
      await host.ping()
      await guest.ping()
      await host.ping()

      for (const [receiver, senderRole, forbiddenType] of [
        [guest, 'host', 'answer'],
        [host, 'guest', 'offer'],
      ] as const) {
        expect(receiver.invalidFrames).toEqual([])
        for (const message of receiver.received) {
          if (message.type === 'error') coverage.rejected += 1
          if (message.type !== 'signal') continue
          const context = `round=${round} receiver=${senderRole === 'host' ? 'guest' : 'host'}`
          expect(sentBy[senderRole].has(canonicalJson(message.payload)), context).toBe(true)
          expect(descriptionType(message.payload), context).not.toBe(forbiddenType)
          if (senderRole === 'host') coverage.relayedToGuest += 1
          else coverage.relayedToHost += 1
        }
      }
      host.socket.close()
      guest.socket.close()
    }

    console.info('approved fuzz coverage', coverage)
    expect(coverage.relayedToGuest).toBeGreaterThan(APPROVED_ROUNDS * 15)
    expect(coverage.relayedToHost).toBeGreaterThan(APPROVED_ROUNDS * 15)
    expect(coverage.rejected).toBeGreaterThan(APPROVED_ROUNDS * 50)
    expect(polluted()).toBeUndefined()
    await expectHealthy(port)
    await expectValidRelay(url)
  }, 60_000)

  it('terminates abusive sockets under default limits without degrading service', async () => {
    const { port, url } = await startServer()
    const random = new SeededRandom(FUZZ_SEED ^ 0xab05e)
    let client = await openClient(url)
    let terminations = 0

    for (let iteration = 0; iteration < ABUSE_FRAMES; iteration += 1) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        terminations += 1
        client = await openClient(url)
      }
      const frame = random.chance(0.5)
        ? random.pick(PROTOTYPE_FRAMES)
        : JSON.stringify(randomJsonValue(random))
      client.socket.send(frame)
      if (iteration % 8 === 7) await client.ping()
      expect(client.invalidFrames).toEqual([])
    }

    expect(terminations).toBeGreaterThan(0)
    expect(polluted()).toBeUndefined()
    await expectHealthy(port)
    await expectValidRelay(url)
  }, 60_000)
})

function webSocketOrigin(url: string): string {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.origin
}
