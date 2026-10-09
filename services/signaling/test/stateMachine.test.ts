import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  SIGNALING_SUBPROTOCOL,
  serverMessageSchema,
  type ClientMessage,
  type ControlAccessMode,
  type ServerMessage,
  type SignalingPayload,
} from '@ediz-remote/protocol'
import {
  createSignalingServer,
  type SignalingSecurityOptions,
  type SignalingServer,
  type SignalingServerOptions,
} from '../src/server.js'

// Tablo tabanlı signaling durum makinesi matrisi: durum × rol × mesaj.
//
// Her satır taze bir sunucuda (enjekte saatle) bir fikstür durumu kurar, tek bir
// mesaj gönderir ve iki şeyi doğrular: (a) gönderene dönen yanıt dizisi,
// (b) diğer bütün soketlerin (karşı taraf, üçüncü soket, başka oturum) aldığı
// mesajların tam listesi. Yanıt gelmeyen satırlarda yokluk ping/pong sıra
// bariyeriyle kanıtlanır: sunucu bir soketin mesajlarını sırayla işler ve aynı
// soketteki çıktıları sırayla yazar; bu nedenle bariyer pong'undan önce gelmeyen
// mesaj hiç gönderilmemiştir. Sunucunun her frame'i `serverMessageSchema`ya uymalı.
//
// Beklentiler `src/server.ts`'deki mevcut davranıştan türetildi. Kod TTL'i ve
// grace denetimleri mesaj anında (`join_session`, `request_decision`,
// `resume_session`) yapılır; periyodik temizlik (30 sn) yalnız onaysız oturumları
// siler ve grace zaman aşımı gerçek zamanlayıcıyla çalışır.

const BASE_TIME = Date.parse('2026-10-09T12:00:00.000Z')
// server.ts SESSION_TTL_MS ve DEFAULT_RECONNECT_GRACE_MS ile aynı tutulmalı.
const SESSION_TTL_MS = 10 * 60 * 1000
const DEFAULT_GRACE_MS = 30_000
const SHORT_GRACE_MS = 1_000
const WAIT_TIMEOUT_MS = 3_000

const N1 = '11111111-1111-4111-8111-111111111111'
const NV1 = '22222222-2222-4222-8222-222222222222'
const N2 = '33333333-3333-4333-8333-333333333333'
const NV2 = '44444444-4444-4444-8444-444444444444'
const N3 = '55555555-5555-4555-8555-555555555555'
const N_UNKNOWN = '66666666-6666-4666-8666-666666666666'
const UNKNOWN_REQUEST_ID = '19f3d8f5-2af5-4e77-a155-41e60d94c1b2'
const UNKNOWN_RESUME_TOKEN = 'A'.repeat(43)

// Yetkisiz hücrede karşı tarafa asla ulaşmaması gereken mesaj türleri.
const SENSITIVE_TYPES = new Set([
  'signal',
  'session_approved',
  'peer_joined',
  'ice_configuration',
])

const NA = ['error:not_authorized']
const INVALID_RESUME = ['error:invalid_resume']
const SILENT: string[] = []

const GENEROUS_BUCKET = { capacity: 1_000_000, refillPerSecond: 1_000_000 }
const GENEROUS_BYTES = { capacity: 1_000_000_000, refillPerSecond: 1_000_000_000 }
const generousSignalSecurity: SignalingSecurityOptions = {
  globalInboundMessages: GENEROUS_BUCKET,
  globalInboundBytes: GENEROUS_BYTES,
  inboundMessages: GENEROUS_BUCKET,
  inboundBytes: GENEROUS_BYTES,
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

// ---------------------------------------------------------------------------
// İstemci ve ortam

interface Client {
  name: string
  socket: WebSocket
  clientId: string
  received: ServerMessage[]
  invalidFrames: string[]
  readonly closed: boolean
  send(message: ClientMessage): void
  waitUntil(predicate: () => boolean, what: string, timeoutMs?: number): Promise<void>
  waitFor<T extends ServerMessage['type']>(
    type: T,
    fromIndex: number,
    timeoutMs?: number,
  ): Promise<Extract<ServerMessage, { type: T }>>
  barrier(): Promise<'pong' | 'closed'>
}

type Ctx = Record<string, string>

interface Env {
  url: string
  clock: { now: number }
  clients: Map<string, Client>
  codes: Set<string>
  ctx: Ctx
  open(name: string): Promise<Client>
  get(name: string): Client
}

async function openClient(url: string, name: string): Promise<Client> {
  const socket = new WebSocket(url, SIGNALING_SUBPROTOCOL, {
    origin: webSocketOrigin(url),
  })
  openSockets.push(socket)
  const received: ServerMessage[] = []
  const invalidFrames: string[] = []
  const listeners = new Set<() => void>()
  let closed = false
  let pingsSent = 0
  let pongsReceived = 0

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
    if (result.data.type === 'pong') pongsReceived += 1
    received.push(result.data)
    for (const listener of listeners) listener()
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  const waitUntil = (
    predicate: () => boolean,
    what: string,
    timeoutMs = WAIT_TIMEOUT_MS,
  ) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!predicate()) return
        clearTimeout(timer)
        listeners.delete(check)
        resolve()
      }
      const timer = setTimeout(() => {
        listeners.delete(check)
        reject(
          new Error(
            `${name}: ${what} beklenirken zaman aşımı; alınan: ${received
              .map(describeMessage)
              .join(', ')}`,
          ),
        )
      }, timeoutMs)
      listeners.add(check)
      check()
    })

  const waitFor = async <T extends ServerMessage['type']>(
    type: T,
    fromIndex: number,
    timeoutMs?: number,
  ) => {
    const find = () =>
      received.slice(fromIndex).find((message) => message.type === type)
    await waitUntil(() => find() !== undefined, type, timeoutMs)
    return find() as Extract<ServerMessage, { type: T }>
  }

  const client: Client = {
    name,
    socket,
    clientId: '',
    received,
    invalidFrames,
    get closed() {
      return closed
    },
    send(message) {
      if (message.type === 'ping') pingsSent += 1
      socket.send(JSON.stringify(message), () => undefined)
    },
    waitUntil,
    waitFor,
    async barrier() {
      if (closed) return 'closed'
      pingsSent += 1
      const target = pingsSent
      socket.send(JSON.stringify({ type: 'ping' }), () => undefined)
      await waitUntil(
        () => closed || pongsReceived >= target,
        'ping/pong bariyeri',
      )
      return pongsReceived >= target ? 'pong' : 'closed'
    },
  }
  const ready = await waitFor('ready', 0)
  client.clientId = ready.clientId
  return client
}

async function startEnv(options: SignalingServerOptions = {}): Promise<Env> {
  const clock = { now: BASE_TIME }
  const server = createSignalingServer({
    ...options,
    port: 0,
    host: '127.0.0.1',
    staticDir: null,
    now: () => clock.now,
  })
  runningServers.push(server)
  const port = await server.start()
  const url = `ws://127.0.0.1:${port}/ws`
  const clients = new Map<string, Client>()
  const env: Env = {
    url,
    clock,
    clients,
    codes: new Set(),
    ctx: {},
    async open(name) {
      const existing = clients.get(name)
      if (existing && !existing.closed) {
        throw new Error(`${name} zaten açık`)
      }
      const client = await openClient(url, name)
      clients.set(name, client)
      return client
    },
    get(name) {
      const client = clients.get(name)
      if (!client) throw new Error(`Fikstürde ${name} soketi yok`)
      return client
    },
  }
  return env
}

function describeMessage(message: ServerMessage): string {
  if (message.type === 'error') return `error:${message.code}`
  if (message.type === 'session_ended') return `session_ended:${message.reason}`
  return message.type
}

function need(env: Env, key: string): string {
  const value = env.ctx[key]
  if (value === undefined) throw new Error(`Fikstür bağlamında ${key} yok`)
  return value
}

function unusedCode(env: Env): string {
  let candidate = (Number(env.ctx.code ?? '0') + 500_001) % 1_000_000
  for (;;) {
    const code = candidate.toString().padStart(6, '0')
    if (!env.codes.has(code)) return code
    candidate = (candidate + 1) % 1_000_000
  }
}

// ---------------------------------------------------------------------------
// Hücre yürütücü

type CellOutput = Map<string, ServerMessage[]>

interface CellExpectation {
  reply: readonly string[]
  peers?: Readonly<Record<string, readonly string[]>>
  grants?: boolean
}

// Aktör mesajı gönderir; önce aktör, sonra fikstürdeki her açık soket bariyerden
// geçer. Bariyer pong'u listeden çıkarılır; bariyer sırasında kapanan soket
// listesine `#closed` eklenir.
async function runCell(
  env: Env,
  actorName: string,
  label: string,
  message: ClientMessage,
  expected: CellExpectation,
): Promise<CellOutput> {
  const actor = env.clients.has(actorName) && !env.get(actorName).closed
    ? env.get(actorName)
    : await env.open(actorName)
  const marks = new Map<string, number>()
  for (const [name, client] of env.clients) {
    if (!client.closed) marks.set(name, client.received.length)
  }

  actor.send(message)
  const barrierResults = new Map<string, 'pong' | 'closed'>()
  barrierResults.set(actorName, await actor.barrier())
  for (const name of marks.keys()) {
    if (name === actorName) continue
    barrierResults.set(name, await env.get(name).barrier())
  }

  const output: CellOutput = new Map()
  const described = new Map<string, string[]>()
  for (const [name, mark] of marks) {
    const client = env.get(name)
    const messages = client.received.slice(mark)
    const labels = messages.map(describeMessage)
    if (barrierResults.get(name) === 'pong') {
      const index = labels.lastIndexOf('pong')
      expect(index, `${label} → ${name}: bariyer pong'u yok`).toBeGreaterThanOrEqual(0)
      labels.splice(index, 1)
      messages.splice(index, 1)
    } else {
      labels.push('#closed')
    }
    output.set(name, messages)
    described.set(name, labels)
  }

  expect(described.get(actorName), `${label} → gönderen (${actorName}) yanıtı`).toEqual(
    expected.reply,
  )
  for (const [name, labels] of described) {
    if (name === actorName) continue
    const peerExpected = expected.peers?.[name] ?? []
    if (!expected.grants) {
      const leaked = labels.filter((type) => SENSITIVE_TYPES.has(type))
      expect(leaked, `${label} → ${name}: SIZINTI (yetkisiz hücre)`).toEqual([])
    }
    expect(labels, `${label} → ${name} (karşı taraf / üçüncü soket)`).toEqual(
      peerExpected,
    )
  }
  for (const [name, client] of env.clients) {
    expect(client.invalidFrames, `${label} → ${name}: şemaya uymayan frame`).toEqual([])
  }
  return output
}

// ---------------------------------------------------------------------------
// Payload ve mesaj katalogu

function negotiationIdForIndex(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

function descriptionSignal(
  type: 'offer' | 'answer',
  negotiationId: string,
): SignalingPayload {
  return {
    kind: 'session-description',
    negotiationId,
    description: { type, sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' },
  }
}

function candidateSignal(negotiationId: string): SignalingPayload {
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

function nativeDescriptionSignal(
  type: 'offer' | 'answer',
  negotiationId: string,
): SignalingPayload {
  return {
    channel: 'native-video',
    version: 2,
    signal: {
      kind: 'session-description',
      negotiationId,
      description: { type, sdp: 'v=0\r\n' },
    },
  }
}

function nativeCandidateSignal(negotiationId: string): SignalingPayload {
  return {
    channel: 'native-video',
    version: 2,
    signal: {
      kind: 'ice-candidate',
      negotiationId,
      candidate: { candidate: 'candidate:2 1 udp 1 192.0.2.2 9 typ host' },
    },
  }
}

function signal(payload: SignalingPayload): ClientMessage {
  return { type: 'signal', payload }
}

function decision(
  requestId: string,
  approved: boolean,
  accessMode?: ControlAccessMode,
): ClientMessage {
  return approved
    ? { type: 'request_decision', requestId, approved, accessMode }
    : { type: 'request_decision', requestId, approved }
}

const MESSAGES = {
  'create_session': () => ({ type: 'create_session' }),
  'join_session (doğru kod)': (env) => ({
    type: 'join_session',
    code: need(env, 'code'),
  }),
  'join_session (yanlış kod)': (env) => ({
    type: 'join_session',
    code: unusedCode(env),
  }),
  'request_decision (fikstür requestId, onay view)': (env) =>
    decision(need(env, 'requestId'), true, 'view'),
  'request_decision (fikstür requestId, onay control)': (env) =>
    decision(need(env, 'requestId'), true, 'control'),
  'request_decision (fikstür requestId, red)': (env) =>
    decision(need(env, 'requestId'), false),
  'request_decision (yanlış requestId, onay control)': () =>
    decision(UNKNOWN_REQUEST_ID, true, 'control'),
  'request_decision (yanlış requestId, red)': () =>
    decision(UNKNOWN_REQUEST_ID, false),
  'signal peer offer N1': () => signal(descriptionSignal('offer', N1)),
  'signal peer offer N2': () => signal(descriptionSignal('offer', N2)),
  'signal peer offer N3': () => signal(descriptionSignal('offer', N3)),
  'signal peer answer N1': () => signal(descriptionSignal('answer', N1)),
  'signal peer answer N2': () => signal(descriptionSignal('answer', N2)),
  'signal peer ICE N1': () => signal(candidateSignal(N1)),
  'signal peer ICE N2': () => signal(candidateSignal(N2)),
  'signal peer ICE (bilinmeyen kimlik)': () => signal(candidateSignal(N_UNKNOWN)),
  'signal peer ICE NV2 (yanlış lane kimliği)': () => signal(candidateSignal(NV2)),
  'signal native offer NV1': () => signal(nativeDescriptionSignal('offer', NV1)),
  'signal native offer NV2': () => signal(nativeDescriptionSignal('offer', NV2)),
  'signal native answer NV1': () => signal(nativeDescriptionSignal('answer', NV1)),
  'signal native answer NV2': () => signal(nativeDescriptionSignal('answer', NV2)),
  'signal native ICE NV1': () => signal(nativeCandidateSignal(NV1)),
  'signal native ICE N2 (yanlış lane kimliği)': () =>
    signal(nativeCandidateSignal(N2)),
  'signal peer offer #1 (görülmüş)': () =>
    signal(descriptionSignal('offer', negotiationIdForIndex(1))),
  'signal peer offer #257 (yeni)': () =>
    signal(descriptionSignal('offer', negotiationIdForIndex(257))),
  'signal peer answer #256': () =>
    signal(descriptionSignal('answer', negotiationIdForIndex(256))),
  'signal peer ICE #256': () => signal(candidateSignal(negotiationIdForIndex(256))),
  'resume_session (bilinmeyen token)': () => ({
    type: 'resume_session',
    token: UNKNOWN_RESUME_TOKEN,
  }),
  'resume_session (host token)': (env) => ({
    type: 'resume_session',
    token: need(env, 'hostToken'),
  }),
  'resume_session (misafir token)': (env) => ({
    type: 'resume_session',
    token: need(env, 'guestToken'),
  }),
  'resume_session (eski misafir token)': (env) => ({
    type: 'resume_session',
    token: need(env, 'oldGuestToken'),
  }),
  'refresh_ice': () => ({ type: 'refresh_ice' }),
  'revoke_control': () => ({
    type: 'revoke_control',
    channel: 'control',
    version: 1,
  }),
  'leave_session': () => ({ type: 'leave_session' }),
  'ping': () => ({ type: 'ping' }),
} satisfies Record<string, (env: Env) => ClientMessage>

type MessageName = keyof typeof MESSAGES

// ---------------------------------------------------------------------------
// Fikstür yardımcıları

async function createHostSession(env: Env, hostName = 'h', codeKey = 'code') {
  const host = env.clients.get(hostName) ?? (await env.open(hostName))
  const from = host.received.length
  host.send({ type: 'create_session' })
  const created = await host.waitFor('session_created', from)
  env.codes.add(created.code)
  env.ctx[codeKey] = created.code
  return created.code
}

async function requestJoin(
  env: Env,
  guestName = 'g',
  hostName = 'h',
  codeKey = 'code',
  requestKey = 'requestId',
) {
  const guest = env.clients.get(guestName) ?? (await env.open(guestName))
  const host = env.get(hostName)
  const guestFrom = guest.received.length
  const hostFrom = host.received.length
  guest.send({ type: 'join_session', code: need(env, codeKey) })
  const pending = await guest.waitFor('join_pending', guestFrom)
  const incoming = await host.waitFor('incoming_request', hostFrom)
  expect(incoming.requestId).toBe(pending.requestId)
  env.ctx[requestKey] = incoming.requestId
  return incoming.requestId
}

async function approve(
  env: Env,
  mode: ControlAccessMode,
  hostName = 'h',
  guestName = 'g',
  prefix = '',
) {
  const host = env.get(hostName)
  const guest = env.get(guestName)
  const requestKey = prefix ? `${prefix}RequestId` : 'requestId'
  const hostFrom = host.received.length
  const guestFrom = guest.received.length
  host.send(decision(need(env, requestKey), true, mode))
  const approved = await guest.waitFor('session_approved', guestFrom)
  const joined = await host.waitFor('peer_joined', hostFrom)
  env.ctx[prefix ? `${prefix}HostToken` : 'hostToken'] = joined.resumeToken
  env.ctx[prefix ? `${prefix}GuestToken` : 'guestToken'] = approved.resumeToken
}

async function approvedSession(
  env: Env,
  mode: ControlAccessMode,
  hostName = 'h',
  guestName = 'g',
  prefix = '',
) {
  const codeKey = prefix ? `${prefix}Code` : 'code'
  const requestKey = prefix ? `${prefix}RequestId` : 'requestId'
  await createHostSession(env, hostName, codeKey)
  await requestJoin(env, guestName, hostName, codeKey, requestKey)
  await approve(env, mode, hostName, guestName, prefix)
}

async function relay(
  env: Env,
  fromName: string,
  toName: string,
  payload: SignalingPayload,
) {
  const sender = env.get(fromName)
  const recipient = env.get(toName)
  const from = recipient.received.length
  sender.send(signal(payload))
  const relayed = await recipient.waitFor('signal', from)
  expect(relayed.payload).toEqual(payload)
}

async function suspend(env: Env, name: string, observerName?: string) {
  const client = env.get(name)
  const observer = observerName ? env.get(observerName) : undefined
  const from = observer?.received.length ?? 0
  client.socket.close()
  await client.waitUntil(() => client.closed, 'kapanış')
  env.clients.delete(name)
  if (observer) await observer.waitFor('peer_suspended', from)
}

async function resumeInto(
  env: Env,
  name: string,
  token: string,
  observerName?: string,
) {
  const client = await env.open(name)
  const observer = observerName ? env.get(observerName) : undefined
  const observerFrom = observer?.received.length ?? 0
  const from = client.received.length
  client.send({ type: 'resume_session', token })
  const resumed = await client.waitFor('session_resumed', from)
  if (observer) await observer.waitFor('peer_resumed', observerFrom)
  return resumed
}

// E fikstürü: onaylı oturum; peer N1 ve native NV1 offer'ları aktarılmış,
// answer'lar henüz yok. Üçüncü soket `x` sızıntı gözlemcisidir.
async function approvedWithOffers(env: Env, mode: ControlAccessMode) {
  await approvedSession(env, mode)
  await relay(env, 'h', 'g', descriptionSignal('offer', N1))
  await relay(env, 'h', 'g', nativeDescriptionSignal('offer', NV1))
  await env.open('x')
}

async function approvedWithAnswers(env: Env) {
  await approvedWithOffers(env, 'view')
  await relay(env, 'g', 'h', descriptionSignal('answer', N1))
  await relay(env, 'g', 'h', nativeDescriptionSignal('answer', NV1))
}

// ---------------------------------------------------------------------------
// Durum fikstürleri

interface Fixture {
  key: string
  title: string
  options?: SignalingServerOptions
  build(env: Env): Promise<void>
}

function fixture(
  key: string,
  title: string,
  build: (env: Env) => Promise<void>,
  options?: SignalingServerOptions,
): Fixture {
  return { key, title, build, options }
}

const A = fixture('A', 'oturumsuz soket x; yanında başka onaylı oturum (h,g)', async (env) => {
  await approvedWithOffers(env, 'view')
})

const B = fixture('B', 'oturum açmış host h, misafir yok; oturumsuz x', async (env) => {
  await createHostSession(env)
  await env.open('x')
})

const C = fixture('C', 'onay bekleyen misafir g + host h; x', async (env) => {
  await createHostSession(env)
  await requestJoin(env)
  await env.open('x')
})

const D = fixture('D', 'reddedilmiş misafir g + host h; x', async (env) => {
  await createHostSession(env)
  await requestJoin(env)
  const guest = env.get('g')
  const from = guest.received.length
  env.get('h').send(decision(need(env, 'requestId'), false))
  await guest.waitFor('request_rejected', from)
  await env.open('x')
})

const E_VIEW = fixture('E-view', 'onaylı oturum (view), N1/NV1 offer aktarılmış', (env) =>
  approvedWithOffers(env, 'view'),
)

const E_CONTROL = fixture(
  'E-control',
  'onaylı oturum (control), N1/NV1 offer aktarılmış',
  (env) => approvedWithOffers(env, 'control'),
)

async function revokedControl(env: Env) {
  await approvedWithOffers(env, 'control')
  env.get('h').send({ type: 'revoke_control', channel: 'control', version: 1 })
  await env.get('h').barrier()
}

const F = fixture('F', 'control onayı sonrası revoke_control', revokedControl)

const F_SUSPENDED = fixture(
  'F-askıda',
  'revoke_control sonrası misafir koptu (grace içinde)',
  async (env) => {
    await revokedControl(env)
    await suspend(env, 'g', 'h')
  },
)

const G_HOST_LEFT = fixture(
  'G-host',
  'host leave_session sonrası iki soket',
  async (env) => {
    await approvedWithOffers(env, 'view')
    const guest = env.get('g')
    const from = guest.received.length
    env.get('h').send({ type: 'leave_session' })
    expect(describeMessage(await guest.waitFor('session_ended', from))).toBe(
      'session_ended:host_left',
    )
  },
)

const G_GUEST_LEFT = fixture(
  'G-misafir',
  'misafir leave_session sonrası iki soket',
  async (env) => {
    await approvedWithOffers(env, 'view')
    const host = env.get('h')
    const from = host.received.length
    env.get('g').send({ type: 'leave_session' })
    await host.waitFor('peer_left', from)
  },
)

function hostSessionAt(offsetMs: number) {
  return async (env: Env) => {
    await createHostSession(env)
    await env.open('x')
    env.clock.now = BASE_TIME + offsetMs
  }
}

function pendingAt(offsetMs: number) {
  return async (env: Env) => {
    await createHostSession(env)
    await requestJoin(env)
    await env.open('x')
    env.clock.now = BASE_TIME + offsetMs
  }
}

const H_B_BEFORE = fixture(
  'H-B-önce',
  'onaysız kod, TTL dolmadan 1 ms önce',
  hostSessionAt(SESSION_TTL_MS - 1),
)
const H_B_AT = fixture(
  'H-B-sınır',
  'onaysız kod, TTL tam doldu (temizlik henüz çalışmadı)',
  hostSessionAt(SESSION_TTL_MS),
)
const H_C_BEFORE = fixture(
  'H-C-önce',
  'bekleyen istek, TTL dolmadan 1 ms önce',
  pendingAt(SESSION_TTL_MS - 1),
)
const H_C_AT = fixture(
  'H-C-sınır',
  'bekleyen istek, TTL tam doldu (temizlik henüz çalışmadı)',
  pendingAt(SESSION_TTL_MS),
)
const H_E_AFTER = fixture(
  'H-E-sonra',
  'onaylı oturum, kod TTL\'inden 1 dk sonra',
  async (env) => {
    await approvedWithOffers(env, 'view')
    env.clock.now = BASE_TIME + SESSION_TTL_MS + 60_000
  },
)

function guestSuspendedAt(offsetMs: number) {
  return async (env: Env) => {
    await approvedWithOffers(env, 'view')
    await suspend(env, 'g', 'h')
    env.clock.now = BASE_TIME + offsetMs
  }
}

const I_GUEST = fixture(
  'I-misafir-askıda',
  'misafir koptu, grace içinde',
  guestSuspendedAt(0),
)
const I_GUEST_EDGE = fixture(
  'I-grace-önce',
  'misafir koptu, grace bitmeden 1 ms önce (enjekte saat)',
  guestSuspendedAt(DEFAULT_GRACE_MS - 1),
)
const I_GUEST_LATE = fixture(
  'I-grace-sınır',
  'misafir koptu, grace saatle doldu, zamanlayıcı henüz çalışmadı',
  guestSuspendedAt(DEFAULT_GRACE_MS),
)
const I_HOST = fixture('I-host-askıda', 'host koptu, grace içinde', async (env) => {
  await approvedWithOffers(env, 'view')
  await suspend(env, 'h', 'g')
})
const I_TIMEOUT = fixture(
  'I-zaman-aşımı',
  'misafir koptu, gerçek grace zamanlayıcısı (1 sn) oturumu bitirdi',
  async (env) => {
    await approvedWithOffers(env, 'view')
    const host = env.get('h')
    const from = host.received.length
    await suspend(env, 'g', 'h')
    const ended = await host.waitFor('session_ended', from, SHORT_GRACE_MS + 4_000)
    expect(describeMessage(ended)).toBe('session_ended:reconnect_timeout')
  },
  { reconnectGraceMs: SHORT_GRACE_MS },
)
const I_BOTH = fixture('I-ikisi-askıda', 'iki eş de koptu', async (env) => {
  await approvedWithOffers(env, 'view')
  await suspend(env, 'g', 'h')
  await suspend(env, 'h')
})

const J_ROTATED = fixture(
  'J-döndürülmüş',
  'misafir resume etti; eski token oldGuestToken, yeni token guestToken',
  async (env) => {
    await approvedWithOffers(env, 'view')
    await suspend(env, 'g', 'h')
    env.ctx.oldGuestToken = need(env, 'guestToken')
    const resumed = await resumeInto(env, 'g', need(env, 'guestToken'), 'h')
    env.ctx.guestToken = resumed.resumeToken
  },
)

const J_BOUND = fixture(
  'J-başka-oturum',
  'iki onaylı oturum; 1. oturumun misafiri askıda, 2. oturum (h2,g2) bağlı',
  async (env) => {
    await approvedSession(env, 'view')
    await approvedSession(env, 'view', 'h2', 'g2', 'second')
    await suspend(env, 'g', 'h')
  },
)

const N_FRESH = fixture('N-0', 'onaylı, henüz offer yok', async (env) => {
  await approvedSession(env, 'view')
  await env.open('x')
})

const N_OFFERED = fixture('N-1', 'onaylı, N1/NV1 offer aktarılmış', (env) =>
  approvedWithOffers(env, 'view'),
)

const N_ANSWERED = fixture(
  'N-2',
  'onaylı, N1/NV1 offer ve answer aktarılmış',
  approvedWithAnswers,
)

const N_RENEGOTIATED = fixture(
  'N-3',
  'N1/NV1 tamamlandı, sonra N2/NV2 offer aktarıldı',
  async (env) => {
    await approvedWithAnswers(env)
    await relay(env, 'h', 'g', descriptionSignal('offer', N2))
    await relay(env, 'h', 'g', nativeDescriptionSignal('offer', NV2))
  },
)

const N_EXHAUSTED = fixture(
  'N-tükenmiş',
  'peer lane\'de 256 farklı offer kimliği görülmüş; native NV1 aktarılmış',
  async (env) => {
    await approvedSession(env, 'view')
    const guest = env.get('g')
    const from = guest.received.length
    for (let index = 1; index <= 256; index += 1) {
      env.get('h').send(
        signal(descriptionSignal('offer', negotiationIdForIndex(index))),
      )
    }
    await guest.waitUntil(
      () =>
        guest.received.slice(from).filter((message) => message.type === 'signal')
          .length >= 256,
      '256 offer aktarımı',
      10_000,
    )
    await relay(env, 'h', 'g', nativeDescriptionSignal('offer', NV1))
    await env.open('x')
  },
  { security: generousSignalSecurity },
)

const N_GUEST_RESUMED = fixture(
  'N-misafir-resume',
  'N1/NV1 tamamlandı, misafir yeni soketle resume etti',
  async (env) => {
    await approvedWithAnswers(env)
    await suspend(env, 'g', 'h')
    await resumeInto(env, 'g', need(env, 'guestToken'), 'h')
  },
)

const N_HOST_RESUMED = fixture(
  'N-host-resume',
  'N1/NV1 tamamlandı, host yeni soketle resume etti',
  async (env) => {
    await approvedWithAnswers(env)
    await suspend(env, 'h', 'g')
    await resumeInto(env, 'h', need(env, 'hostToken'), 'g')
  },
)

// ---------------------------------------------------------------------------
// Matris

interface Row {
  fixture: Fixture
  actor: string
  message: MessageName
  reply: readonly string[]
  peers?: Readonly<Record<string, readonly string[]>>
  grants?: boolean
  note?: string
  check?: (output: CellOutput, env: Env) => void
  followUp?: (env: Env) => Promise<void>
}

type RowSpec = [
  message: MessageName,
  reply: readonly string[],
  extra?: Omit<Row, 'fixture' | 'actor' | 'message' | 'reply'>,
]

const MATRIX: Row[] = []

function rows(target: Fixture, actor: string, specs: RowSpec[]): void {
  for (const [message, reply, extra] of specs) {
    MATRIX.push({ fixture: target, actor, message, reply, ...extra })
  }
}

function follow(
  actor: string,
  message: MessageName,
  reply: readonly string[],
  extra: Omit<CellExpectation, 'reply'> = {},
) {
  return async (env: Env) => {
    await runCell(env, actor, `ardından ${actor}: ${message}`, MESSAGES[message](env), {
      reply,
      ...extra,
    })
  }
}

function accessModeOf(output: CellOutput, name: string): string | undefined {
  const message = output
    .get(name)
    ?.find(
      (candidate) =>
        candidate.type === 'session_resumed' ||
        candidate.type === 'session_approved' ||
        candidate.type === 'peer_joined',
    )
  return message && 'accessMode' in message ? message.accessMode : undefined
}

function resumedPeerConnected(output: CellOutput, name: string): boolean | undefined {
  const message = output.get(name)?.find((candidate) => candidate.type === 'session_resumed')
  return message?.type === 'session_resumed' ? message.peerConnected : undefined
}

// A — oturumsuz soket. h/g başka bir onaylı oturumun üyeleridir; hiçbir şey almamalı.
rows(A, 'x', [
  ['create_session', ['session_created']],
  ['join_session (yanlış kod)', ['error:invalid_code']],
  ['join_session (doğru kod)', ['error:session_busy'], {
    note: 'onaylı oturumun kodu (TTL içinde) tekrar kullanılamaz',
  }],
  ['request_decision (yanlış requestId, onay control)', NA],
  ['request_decision (fikstür requestId, onay control)', NA, {
    note: 'başka oturumun tüketilmiş requestId\'si',
  }],
  ['request_decision (yanlış requestId, red)', NA],
  ['signal peer offer N2', NA],
  ['signal peer answer N1', NA],
  ['signal peer ICE N1', NA],
  ['signal native offer NV2', NA],
  ['signal native ICE NV1', NA],
  ['resume_session (bilinmeyen token)', INVALID_RESUME],
  ['refresh_ice', NA],
  ['revoke_control', NA],
  ['leave_session', SILENT],
  ['ping', ['pong']],
])

// B — oturum açmış host, misafir yok.
rows(B, 'h', [
  ['create_session', ['session_created'], {
    followUp: follow('x', 'join_session (doğru kod)', ['error:invalid_code']),
    note: 'yeni kod eskisinin yerine geçer',
  }],
  ['join_session (doğru kod)', ['error:invalid_code'], {
    note: 'join önce kendi oturumundan çıkarır; kendi kodu artık yok',
    followUp: follow('x', 'join_session (doğru kod)', ['error:invalid_code']),
  }],
  ['join_session (yanlış kod)', ['error:invalid_code'], {
    followUp: follow('x', 'join_session (doğru kod)', ['error:invalid_code']),
  }],
  ['request_decision (yanlış requestId, onay control)', NA],
  ['signal peer offer N1', NA],
  ['signal peer ICE N1', NA],
  ['signal native offer NV1', NA],
  ['signal native ICE NV1', NA],
  ['resume_session (bilinmeyen token)', INVALID_RESUME],
  ['refresh_ice', NA],
  ['revoke_control', NA],
  ['leave_session', SILENT, {
    followUp: follow('x', 'join_session (doğru kod)', ['error:invalid_code']),
  }],
  ['ping', ['pong']],
])
rows(B, 'x', [
  ['join_session (doğru kod)', ['join_pending'], { peers: { h: ['incoming_request'] } }],
  ['join_session (yanlış kod)', ['error:invalid_code']],
  ['request_decision (yanlış requestId, onay control)', NA],
  ['signal peer offer N1', NA],
  ['refresh_ice', NA],
])

// C — onay bekleyen misafir.
rows(C, 'h', [
  ['request_decision (fikstür requestId, onay view)', ['peer_joined'], {
    grants: true,
    peers: { g: ['session_approved'] },
    check: (output) => {
      expect(accessModeOf(output, 'h')).toBe('view')
      expect(accessModeOf(output, 'g')).toBe('view')
    },
  }],
  ['request_decision (fikstür requestId, onay control)', ['peer_joined'], {
    grants: true,
    peers: { g: ['session_approved'] },
    check: (output) => {
      expect(accessModeOf(output, 'h')).toBe('control')
      expect(accessModeOf(output, 'g')).toBe('control')
    },
    followUp: follow('h', 'request_decision (fikstür requestId, onay control)', NA),
  }],
  ['request_decision (fikstür requestId, red)', SILENT, {
    peers: { g: ['request_rejected'] },
    followUp: follow('h', 'request_decision (fikstür requestId, onay control)', NA),
  }],
  ['request_decision (yanlış requestId, onay control)', NA, {
    followUp: follow('h', 'request_decision (fikstür requestId, onay view)', ['peer_joined'], {
      grants: true,
      peers: { g: ['session_approved'] },
    }),
  }],
  ['request_decision (yanlış requestId, red)', NA],
  ['signal peer offer N1', NA],
  ['signal peer ICE N1', NA],
  ['signal native offer NV1', NA],
  ['refresh_ice', NA],
  ['revoke_control', NA],
  ['resume_session (bilinmeyen token)', INVALID_RESUME],
  ['leave_session', SILENT, { peers: { g: ['session_ended:host_left'] } }],
  ['create_session', ['session_created'], { peers: { g: ['session_ended:replaced'] } }],
  ['join_session (yanlış kod)', ['error:invalid_code'], {
    peers: { g: ['session_ended:host_left'] },
  }],
  ['ping', ['pong']],
])
rows(C, 'g', [
  ['request_decision (fikstür requestId, onay control)', NA, {
    note: 'misafir kendi isteğini onaylayamaz; istek bekler',
    followUp: follow('h', 'request_decision (fikstür requestId, onay view)', ['peer_joined'], {
      grants: true,
      peers: { g: ['session_approved'] },
    }),
  }],
  ['request_decision (fikstür requestId, red)', NA],
  ['signal peer answer N1', NA],
  ['signal peer offer N1', NA],
  ['signal peer ICE N1', NA],
  ['signal native answer NV1', NA],
  ['refresh_ice', NA],
  ['revoke_control', NA],
  ['resume_session (bilinmeyen token)', INVALID_RESUME],
  ['join_session (doğru kod)', ['join_pending'], {
    peers: { h: ['incoming_request'] },
    note: 'yeniden istek yeni requestId üretir; eskisi geçersizleşir',
    followUp: follow('h', 'request_decision (fikstür requestId, onay control)', NA),
  }],
  ['join_session (yanlış kod)', ['error:invalid_code'], {
    note: 'bekleyen istek host\'a bildirilmeden düşer',
    followUp: follow('h', 'request_decision (fikstür requestId, onay control)', NA),
  }],
  ['leave_session', SILENT, {
    followUp: follow('h', 'request_decision (fikstür requestId, onay control)', NA),
  }],
  ['create_session', ['session_created'], {
    followUp: follow('h', 'request_decision (fikstür requestId, onay control)', NA),
  }],
  ['ping', ['pong']],
])
rows(C, 'x', [
  ['join_session (doğru kod)', ['error:session_busy']],
  ['request_decision (fikstür requestId, onay control)', NA, {
    note: 'requestId bilen üçüncü soket onay veremez',
  }],
  ['signal peer offer N1', NA],
  ['refresh_ice', NA],
])

// D — reddedilmiş misafir.
rows(D, 'g', [
  ['request_decision (fikstür requestId, onay control)', NA],
  ['signal peer answer N1', NA],
  ['signal peer ICE N1', NA],
  ['signal native answer NV1', NA],
  ['refresh_ice', NA],
  ['revoke_control', NA],
  ['resume_session (bilinmeyen token)', INVALID_RESUME],
  ['join_session (doğru kod)', ['join_pending'], {
    peers: { h: ['incoming_request'] },
    note: 'yeni istek host\'un yeni kararını gerektirir',
  }],
  ['leave_session', SILENT],
  ['ping', ['pong']],
])
rows(D, 'h', [
  ['request_decision (fikstür requestId, onay control)', NA, {
    note: 'reddedilmiş isteğin replay onayı',
  }],
  ['request_decision (fikstür requestId, red)', NA],
  ['signal peer offer N1', NA],
  ['refresh_ice', NA],
  ['revoke_control', NA],
])

// E — onaylı oturum; view ve control için aynı satırlar.
for (const [target, mode] of [
  [E_VIEW, 'view'],
  [E_CONTROL, 'control'],
] as const) {
  rows(target, 'h', [
    ['signal peer offer N2', SILENT, { grants: true, peers: { g: ['signal'] } }],
    ['signal native offer NV2', SILENT, { grants: true, peers: { g: ['signal'] } }],
    ['signal peer ICE N1', SILENT, { grants: true, peers: { g: ['signal'] } }],
    ['signal native ICE NV1', SILENT, { grants: true, peers: { g: ['signal'] } }],
    ['signal peer ICE (bilinmeyen kimlik)', SILENT],
    ['signal peer answer N1', NA],
    ['signal native answer NV1', NA],
    ['request_decision (fikstür requestId, onay control)', NA],
    ['refresh_ice', ['ice_configuration']],
    ['revoke_control', SILENT, {
      followUp: follow('x', 'resume_session (misafir token)', ['session_resumed'], {
        grants: true,
        peers: { h: ['peer_resumed'], g: ['#closed'] },
      }),
    }],
    ['resume_session (host token)', INVALID_RESUME, {
      note: 'bağlı sokette resume yok (kendi geçerli token\'ı olsa da)',
    }],
    ['leave_session', SILENT, {
      peers: { g: ['session_ended:host_left'] },
      followUp: follow('x', 'resume_session (misafir token)', INVALID_RESUME),
    }],
    ['create_session', ['session_created'], {
      peers: { g: ['session_ended:replaced'] },
      followUp: follow('x', 'resume_session (misafir token)', INVALID_RESUME),
    }],
    ['join_session (doğru kod)', ['error:invalid_code'], {
      peers: { g: ['session_ended:host_left'] },
    }],
    ['ping', ['pong']],
  ])
  rows(target, 'g', [
    ['signal peer answer N1', SILENT, { grants: true, peers: { h: ['signal'] } }],
    ['signal native answer NV1', SILENT, { grants: true, peers: { h: ['signal'] } }],
    ['signal peer ICE N1', SILENT, { grants: true, peers: { h: ['signal'] } }],
    ['signal native ICE NV1', SILENT, { grants: true, peers: { h: ['signal'] } }],
    ['signal peer offer N2', NA],
    ['signal native offer NV2', NA],
    ['refresh_ice', ['ice_configuration']],
    ['revoke_control', NA],
    ['request_decision (fikstür requestId, onay control)', NA],
    ['resume_session (misafir token)', INVALID_RESUME],
    ['leave_session', SILENT, {
      peers: { h: ['peer_left'] },
      followUp: follow('x', 'resume_session (host token)', INVALID_RESUME),
    }],
    ['join_session (doğru kod)', ['error:invalid_code'], { peers: { h: ['peer_left'] } }],
    ['create_session', ['session_created'], { peers: { h: ['peer_left'] } }],
    ['ping', ['pong']],
  ])
  rows(target, 'x', [
    ['join_session (doğru kod)', ['error:session_busy']],
    ['request_decision (fikstür requestId, onay control)', NA],
    ['signal peer offer N2', NA],
    ['signal peer ICE N1', NA],
    ['refresh_ice', NA],
    ['revoke_control', NA],
    ['resume_session (misafir token)', ['session_resumed'], {
      grants: true,
      peers: { h: ['peer_resumed'], g: ['#closed'] },
      note: 'güncel token boş sokette aktif misafiri devralır (ER-T04 tasarımı)',
      check: (output) => expect(accessModeOf(output, 'x')).toBe(mode),
    }],
  ])
}

// F — revoke_control sonrası kontrol geri gelmez; view sürer.
rows(F, 'h', [
  ['revoke_control', SILENT],
  ['request_decision (fikstür requestId, onay control)', NA, {
    note: 'eski onay isteğiyle control\'e geri yükseltme yok',
  }],
  ['signal peer offer N2', SILENT, { grants: true, peers: { g: ['signal'] } }],
  ['refresh_ice', ['ice_configuration']],
])
rows(F, 'g', [
  ['revoke_control', NA],
  ['signal peer answer N1', SILENT, { grants: true, peers: { h: ['signal'] } }],
  ['request_decision (fikstür requestId, onay control)', NA],
])
rows(F, 'x', [
  ['resume_session (misafir token)', ['session_resumed'], {
    grants: true,
    peers: { h: ['peer_resumed'], g: ['#closed'] },
    check: (output) => expect(accessModeOf(output, 'x')).toBe('view'),
  }],
  ['resume_session (host token)', ['session_resumed'], {
    grants: true,
    peers: { g: ['peer_resumed'], h: ['#closed'] },
    check: (output) => expect(accessModeOf(output, 'x')).toBe('view'),
  }],
])
rows(F_SUSPENDED, 'r', [
  ['resume_session (misafir token)', ['session_resumed'], {
    grants: true,
    peers: { h: ['peer_resumed'] },
    check: (output) => {
      expect(accessModeOf(output, 'r')).toBe('view')
      expect(resumedPeerConnected(output, 'r')).toBe(true)
    },
  }],
])
rows(F_SUSPENDED, 'h', [
  ['signal peer offer N2', ['error:peer_unavailable']],
  ['revoke_control', SILENT],
])

// G — leave_session sonrası iki soket ve eski token'lar.
for (const target of [G_HOST_LEFT, G_GUEST_LEFT]) {
  rows(target, 'h', [
    ['signal peer offer N2', NA],
    ['signal peer ICE N1', NA],
    ['signal native offer NV2', NA],
    ['refresh_ice', NA],
    ['revoke_control', NA],
    ['request_decision (fikstür requestId, onay control)', NA],
    ['resume_session (host token)', INVALID_RESUME],
    ['join_session (doğru kod)', ['error:invalid_code']],
    ['leave_session', SILENT],
    ['ping', ['pong']],
  ])
  rows(target, 'g', [
    ['signal peer answer N1', NA],
    ['signal peer ICE N1', NA],
    ['signal native answer NV1', NA],
    ['refresh_ice', NA],
    ['revoke_control', NA],
    ['request_decision (fikstür requestId, onay control)', NA],
    ['resume_session (misafir token)', INVALID_RESUME],
    ['join_session (doğru kod)', ['error:invalid_code']],
    ['leave_session', SILENT],
    ['ping', ['pong']],
  ])
  rows(target, 'x', [
    ['resume_session (misafir token)', INVALID_RESUME],
    ['resume_session (host token)', INVALID_RESUME],
    ['join_session (doğru kod)', ['error:invalid_code']],
  ])
}

// H — süresi geçmiş kod / bekleyen istek; enjekte saatle mesaj anında denetim.
rows(H_B_BEFORE, 'x', [
  ['join_session (doğru kod)', ['join_pending'], { peers: { h: ['incoming_request'] } }],
])
rows(H_B_AT, 'x', [
  ['join_session (doğru kod)', ['error:invalid_code'], {
    peers: { h: ['session_ended:expired'] },
    followUp: follow('h', 'signal peer offer N1', NA),
  }],
])
rows(H_B_AT, 'h', [
  ['signal peer offer N1', NA],
  ['refresh_ice', NA],
  ['resume_session (bilinmeyen token)', INVALID_RESUME],
  ['create_session', ['session_created'], {
    followUp: follow('x', 'join_session (doğru kod)', ['error:invalid_code']),
  }],
  ['leave_session', SILENT],
])
rows(H_C_BEFORE, 'h', [
  ['request_decision (fikstür requestId, onay control)', ['peer_joined'], {
    grants: true,
    peers: { g: ['session_approved'] },
  }],
])
rows(H_C_AT, 'h', [
  ['request_decision (fikstür requestId, onay control)',
    ['session_ended:expired', 'error:not_authorized'], {
      peers: { g: ['session_ended:expired'] },
      note: 'TTL sonrası karar oturumu bitirir; onay yayınlanmaz',
    }],
  ['request_decision (fikstür requestId, onay view)',
    ['session_ended:expired', 'error:not_authorized'], {
      peers: { g: ['session_ended:expired'] },
    }],
  ['request_decision (fikstür requestId, red)',
    ['session_ended:expired', 'error:not_authorized'], {
      peers: { g: ['session_ended:expired'] },
    }],
  ['signal peer offer N1', NA],
  ['refresh_ice', NA],
])
rows(H_C_AT, 'g', [
  ['request_decision (fikstür requestId, onay control)',
    ['session_ended:expired', 'error:not_authorized'], {
      peers: { h: ['session_ended:expired'] },
    }],
  ['signal peer answer N1', NA],
  ['refresh_ice', NA],
])
rows(H_C_AT, 'x', [
  ['join_session (doğru kod)', ['error:invalid_code'], {
    peers: { h: ['session_ended:expired'], g: ['session_ended:expired'] },
  }],
])
rows(H_E_AFTER, 'h', [
  ['signal peer offer N2', SILENT, {
    grants: true,
    peers: { g: ['signal'] },
    note: 'kod TTL\'i yalnız kullanılmamış kodu sınırlar; onaylı oturum sürer',
  }],
  ['refresh_ice', ['ice_configuration']],
  ['request_decision (fikstür requestId, onay control)',
    ['session_ended:expired', 'error:not_authorized'], {
      peers: { g: ['session_ended:expired'] },
      note: 'ŞÜPHELİ (mevcut davranış): TTL sonrası herhangi bir karar mesajı onaylı oturumu bitirir',
    }],
])
rows(H_E_AFTER, 'g', [
  ['signal peer answer N1', SILENT, { grants: true, peers: { h: ['signal'] } }],
])
rows(H_E_AFTER, 'x', [
  ['join_session (doğru kod)', ['error:invalid_code'], {
    peers: { h: ['session_ended:expired'], g: ['session_ended:expired'] },
    note: 'ŞÜPHELİ (mevcut davranış): kodu bilen üçüncü kişi TTL sonrası onaylı oturumu bitirebilir',
  }],
  ['resume_session (misafir token)', ['session_resumed'], {
    grants: true,
    peers: { h: ['peer_resumed'], g: ['#closed'] },
  }],
])

// I — askıda üye, grace sınırı ve gerçek zaman aşımı.
rows(I_GUEST, 'h', [
  ['signal peer offer N2', ['error:peer_unavailable'], {
    note: 'askıdaki eşe gönderilemeyen offer kimliği tüketilmez',
    followUp: async (env) => {
      await resumeInto(env, 'g', need(env, 'guestToken'), 'h')
      await follow('h', 'signal peer offer N2', SILENT, {
        grants: true,
        peers: { g: ['signal'] },
      })(env)
    },
  }],
  ['signal peer ICE N1', ['error:peer_unavailable']],
  ['signal native offer NV2', ['error:peer_unavailable']],
  ['signal peer answer N1', NA],
  ['refresh_ice', ['ice_configuration']],
  ['revoke_control', SILENT],
  ['request_decision (fikstür requestId, onay control)', NA],
  ['leave_session', SILENT, {
    followUp: follow('x', 'resume_session (misafir token)', INVALID_RESUME),
  }],
  ['ping', ['pong']],
])
rows(I_GUEST, 'x', [
  ['join_session (doğru kod)', ['error:session_busy']],
  ['signal peer offer N2', NA],
  ['refresh_ice', NA],
  ['resume_session (bilinmeyen token)', INVALID_RESUME],
  ['resume_session (misafir token)', ['session_resumed'], {
    grants: true,
    peers: { h: ['peer_resumed'] },
    check: (output) => expect(resumedPeerConnected(output, 'x')).toBe(true),
  }],
  ['resume_session (host token)', ['session_resumed'], {
    grants: true,
    peers: { h: ['#closed'] },
    check: (output) => expect(resumedPeerConnected(output, 'x')).toBe(false),
  }],
])
rows(I_GUEST_EDGE, 'x', [
  ['resume_session (misafir token)', ['session_resumed'], {
    grants: true,
    peers: { h: ['peer_resumed'] },
  }],
])
rows(I_GUEST_LATE, 'x', [
  ['resume_session (misafir token)', INVALID_RESUME, {
    note: 'grace mesaj anında enjekte saatle denetlenir',
  }],
  ['join_session (doğru kod)', ['error:session_busy']],
])
rows(I_GUEST_LATE, 'h', [
  ['signal peer offer N2', ['error:peer_unavailable']],
  ['refresh_ice', ['ice_configuration'], {
    note: 'zamanlayıcı çalışana dek bağlı host onaylı üye sayılır',
  }],
])
rows(I_HOST, 'g', [
  ['signal peer answer N1', ['error:peer_unavailable']],
  ['signal peer ICE N1', ['error:peer_unavailable']],
  ['signal peer offer N2', NA],
  ['refresh_ice', ['ice_configuration']],
  ['revoke_control', NA],
  ['leave_session', SILENT, {
    followUp: follow('x', 'resume_session (host token)', INVALID_RESUME),
  }],
])
rows(I_HOST, 'x', [
  ['resume_session (host token)', ['session_resumed'], {
    grants: true,
    peers: { g: ['peer_resumed'] },
  }],
  ['join_session (doğru kod)', ['error:invalid_code'], {
    peers: { g: ['session_ended:expired'] },
    note: 'ŞÜPHELİ (mevcut davranış): host askıdayken kodu bilen üçüncü kişi oturumu bitirir',
    followUp: follow('r', 'resume_session (host token)', INVALID_RESUME),
  }],
])
rows(I_TIMEOUT, 'x', [
  ['resume_session (misafir token)', INVALID_RESUME],
  ['resume_session (host token)', INVALID_RESUME],
  ['join_session (doğru kod)', ['error:invalid_code']],
])
rows(I_TIMEOUT, 'h', [
  ['signal peer offer N2', NA],
  ['refresh_ice', NA],
  ['resume_session (host token)', INVALID_RESUME],
])
rows(I_BOTH, 'r', [
  ['resume_session (host token)', ['session_resumed'], {
    check: (output) => expect(resumedPeerConnected(output, 'r')).toBe(false),
    followUp: follow('r2', 'resume_session (misafir token)', ['session_resumed'], {
      grants: true,
      peers: { r: ['peer_resumed'] },
    }),
  }],
])

// J — resume token rotasyonu, replay ve bağlı soket.
rows(J_ROTATED, 'x', [
  ['resume_session (eski misafir token)', INVALID_RESUME],
  ['resume_session (misafir token)', ['session_resumed'], {
    grants: true,
    peers: { h: ['peer_resumed'], g: ['#closed'] },
  }],
])
rows(J_ROTATED, 'h', [
  ['resume_session (eski misafir token)', INVALID_RESUME],
  ['resume_session (misafir token)', INVALID_RESUME],
])
rows(J_ROTATED, 'g', [
  ['resume_session (misafir token)', INVALID_RESUME],
  ['resume_session (eski misafir token)', INVALID_RESUME],
])
rows(J_BOUND, 'g2', [
  ['resume_session (misafir token)', INVALID_RESUME, {
    note: 'başka oturuma bağlı soket geçerli token\'la da resume edemez; token tüketilmez',
    followUp: follow('x', 'resume_session (misafir token)', ['session_resumed'], {
      grants: true,
      peers: { h: ['peer_resumed'] },
    }),
  }],
])
rows(J_BOUND, 'h2', [
  ['resume_session (misafir token)', INVALID_RESUME],
  ['resume_session (host token)', INVALID_RESUME],
])
rows(J_BOUND, 'h', [
  ['resume_session (misafir token)', INVALID_RESUME],
])

// N — negotiation replay.
rows(N_FRESH, 'g', [
  ['signal peer answer N1', SILENT, { note: 'offer öncesi answer düşer' }],
  ['signal peer ICE N1', SILENT],
  ['signal native answer NV1', SILENT],
])
rows(N_FRESH, 'h', [
  ['signal peer ICE N1', SILENT],
  ['signal peer offer N1', SILENT, { grants: true, peers: { g: ['signal'] } }],
])
rows(N_OFFERED, 'h', [
  ['signal peer offer N1', SILENT, { note: 'aynı offer kimliğinin tekrarı relay edilmez' }],
  ['signal native offer NV1', SILENT],
])
rows(N_OFFERED, 'g', [
  ['signal peer answer N1', SILENT, {
    grants: true,
    peers: { h: ['signal'] },
    followUp: follow('g', 'signal peer answer N1', SILENT),
  }],
  ['signal peer offer N1', NA, { note: 'misafir offer\'ı' }],
  ['signal native offer NV1', NA],
])
rows(N_ANSWERED, 'g', [
  ['signal peer answer N1', SILENT, { note: 'aynı kimliğe ikinci answer düşer' }],
  ['signal native answer NV1', SILENT],
  ['signal peer ICE N1', SILENT, { grants: true, peers: { h: ['signal'] } }],
])
rows(N_ANSWERED, 'h', [
  ['signal peer offer N1', SILENT],
  ['signal peer answer N1', NA, { note: 'host answer\'ı' }],
  ['signal native answer NV1', NA],
])
rows(N_RENEGOTIATED, 'h', [
  ['signal peer ICE N1', SILENT, { note: 'yeni offer sonrası eski kimliğin candidate\'ı' }],
  ['signal native ICE NV1', SILENT],
  ['signal peer offer N1', SILENT, { note: 'eski kimliğe geri sarma yok' }],
  ['signal peer ICE N2', SILENT, { grants: true, peers: { g: ['signal'] } }],
  ['signal peer ICE NV2 (yanlış lane kimliği)', SILENT],
  ['signal native ICE N2 (yanlış lane kimliği)', SILENT],
  ['signal peer answer N2', NA],
])
rows(N_RENEGOTIATED, 'g', [
  ['signal peer ICE N1', SILENT],
  ['signal peer answer N1', SILENT],
  ['signal peer answer N2', SILENT, { grants: true, peers: { h: ['signal'] } }],
  ['signal native answer NV2', SILENT, { grants: true, peers: { h: ['signal'] } }],
  ['signal peer offer N3', NA],
])
rows(N_EXHAUSTED, 'h', [
  ['signal peer offer #257 (yeni)', ['error:negotiation_exhausted'], {
    followUp: follow('h', 'signal peer offer N3', ['error:negotiation_exhausted']),
  }],
  ['signal peer offer #1 (görülmüş)', SILENT],
  ['signal peer ICE #256', SILENT, { grants: true, peers: { g: ['signal'] } }],
  ['signal native offer NV2', SILENT, {
    grants: true,
    peers: { g: ['signal'] },
    note: 'native-video lane ayrı sayılır',
  }],
])
rows(N_EXHAUSTED, 'g', [
  ['signal peer answer #256', SILENT, { grants: true, peers: { h: ['signal'] } }],
])
rows(N_GUEST_RESUMED, 'h', [
  ['signal peer offer N1', SILENT, { note: 'replay durumu resume boyunca korunur' }],
  ['signal native offer NV1', SILENT],
  ['signal peer ICE N1', SILENT, { grants: true, peers: { g: ['signal'] } }],
  ['signal peer offer N2', SILENT, { grants: true, peers: { g: ['signal'] } }],
])
rows(N_GUEST_RESUMED, 'g', [
  ['signal peer answer N1', SILENT],
])
rows(N_HOST_RESUMED, 'h', [
  ['signal peer offer N1', SILENT],
  ['signal native offer NV1', SILENT],
  ['signal peer offer N2', SILENT, { grants: true, peers: { g: ['signal'] } }],
])
rows(N_HOST_RESUMED, 'g', [
  ['signal peer answer N1', SILENT],
])

// ---------------------------------------------------------------------------

describe('signaling durum makinesi matrisi', () => {
  it('matris tablosu tutarlı ve istenen kapsamı içeriyor', () => {
    const fixtureKeys = new Set(MATRIX.map((row) => row.fixture.key))
    for (const prefix of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'N']) {
      expect(
        [...fixtureKeys].some((key) => key === prefix || key.startsWith(`${prefix}-`)),
        `durum ${prefix} matriste yok`,
      ).toBe(true)
    }
    const placeholderEnv = {
      ctx: new Proxy({}, { get: () => '000000' }),
      codes: new Set<string>(),
    } as unknown as Env
    const messageTypes = new Set<string>(
      MATRIX.map((row) => MESSAGES[row.message](placeholderEnv).type),
    )
    for (const type of [
      'create_session',
      'join_session',
      'request_decision',
      'signal',
      'resume_session',
      'refresh_ice',
      'revoke_control',
      'leave_session',
      'ping',
    ]) {
      expect(messageTypes.has(type), `${type} matriste yok`).toBe(true)
    }
    for (const row of MATRIX) {
      if (row.grants) continue
      for (const [name, expected] of Object.entries(row.peers ?? {})) {
        const sensitive = expected.filter((type) => SENSITIVE_TYPES.has(type))
        expect(
          sensitive,
          `${row.fixture.key} | ${row.actor} | ${row.message} → ${name}: yetkili işaretlenmemiş satır hassas mesaj bekliyor`,
        ).toEqual([])
      }
    }
    expect(MATRIX.length).toBeGreaterThanOrEqual(200)
  })

  for (const row of MATRIX) {
    const label = `${row.fixture.key} (${row.fixture.title}) | ${row.actor} | ${row.message}`
    it(row.note ? `${label} — ${row.note}` : label, async () => {
      const env = await startEnv(row.fixture.options)
      await row.fixture.build(env)
      const output = await runCell(env, row.actor, label, MESSAGES[row.message](env), {
        reply: row.reply,
        peers: row.peers,
        grants: row.grants,
      })
      row.check?.(output, env)
      await row.followUp?.(env)
    })
  }
})

function webSocketOrigin(url: string): string {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.origin
}
