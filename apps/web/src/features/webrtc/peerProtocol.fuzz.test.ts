import { describe, expect, it } from 'vitest'
import {
  SUSPICIOUS_KEYS,
  SeededRandom,
  addOwnKey,
  canonicalJson,
  cloneJson,
  mutateJson,
  objectPaths,
  randomJsonValue,
  randomString,
  type JsonValue,
} from '../../../../../packages/protocol/test/fuzzSupport'
import {
  isInboundDataChannelMessageAllowed,
  parseDataChannelMessage,
  parseNativeVideoSignalEnvelope,
  parsePeerSignal,
  type DataChannelKind,
  type DataChannelMessage,
  type DataChannelRole,
} from './peerProtocol'

// Uzak eşten DataChannel ile gelen her metin bu ayrıştırıcıdan geçer; host
// tarafında WPF köprüsüne ulaşmadan önceki son tarayıcı sınırıdır.
const FUZZ_SEED = 0x4443_4846
const RANDOM_ITERATIONS = 3_000
const MUTATIONS_PER_SEED = 300
// Yalnız süre bütçesi; kapsam yukarıdaki sabitlerle belirlenir (CI runner'ı
// yerel makineden yavaş olabilir).
const FUZZ_TEST_TIMEOUT_MS = 120_000
const POLLUTION_MARKER = 'edizRemoteFuzzPolluted'

const session = { channel: 'session', version: 2, sequence: 1 } as const
const control = { channel: 'control', version: 1 } as const

const DATA_CHANNEL_SEEDS: JsonValue[] = [
  { type: 'ping', id: 'probe-1', sentAt: 1_760_000_000_000 },
  { type: 'pong', id: 'probe-1', sentAt: 1_760_000_000_000 },
  { ...session, type: 'screen-share-state', active: true },
  { ...session, type: 'media.state', state: 'sharing' },
  { ...session, type: 'cursor.state', x: 0.5, y: 0.25, visible: true },
  { ...session, type: 'quality.state', profile: 'auto' },
  { ...session, type: 'quality.select', profile: 'speed' },
  { ...session, type: 'display.select', displayId: 'display-1' },
  {
    ...session,
    type: 'display.list',
    displays: [
      { id: 'display-1', label: 'Ekran 1', width: 1920, height: 1080 },
      { id: 'display-2', label: 'Ekran 2', width: 2560, height: 1440 },
    ],
    selectedDisplayId: 'display-1',
  },
  { ...control, type: 'control.request', capabilities: ['pointer', 'keyboard'] },
  { ...control, type: 'control.granted', capabilities: ['pointer'] },
  { ...control, type: 'control.revoked', reason: 'host' },
  {
    ...control,
    type: 'control.event',
    sequence: 3,
    event: { kind: 'pointer.move', x: 0.1, y: 0.9 },
  },
  {
    ...control,
    type: 'control.event',
    sequence: 4,
    event: { kind: 'pointer.button', button: 'right', down: false },
  },
  {
    ...control,
    type: 'control.event',
    sequence: 5,
    event: { kind: 'pointer.wheel', deltaX: 12, deltaY: -240 },
  },
  {
    ...control,
    type: 'control.event',
    sequence: 6,
    event: {
      kind: 'keyboard.key',
      code: 'KeyI',
      key: 'ı',
      location: 0,
      down: true,
      repeat: false,
    },
  },
]

const CHANNEL_KINDS: readonly DataChannelKind[] = ['reliable', 'pointer']
const ROLES: readonly DataChannelRole[] = ['host', 'guest']
const OPERATOR_COMMANDS = new Set(['control.event', 'display.select', 'quality.select'])

function polluted(): unknown {
  return (Object.prototype as Record<string, unknown>)[POLLUTION_MARKER]
}

function parseWithoutThrowing(text: string, context: string): DataChannelMessage | null {
  let result: DataChannelMessage | null = null
  expect(() => {
    result = parseDataChannelMessage(text)
  }, context).not.toThrow()
  return result
}

// Kabul edilen her mesaj için yetki matrisinin güvenlik özellikleri: pointer kanalı
// yalnız kontrol yetkili host'a pointer.move taşır; misafir operatör komutu almaz;
// kontrol izni yoksa control.event/control.granted hiçbir yerde kabul edilmez.
function assertAuthorizationMatrix(message: DataChannelMessage, context: string): void {
  for (const channelKind of CHANNEL_KINDS) {
    for (const role of ROLES) {
      for (const controlAllowed of [false, true]) {
        let allowed = false
        expect(() => {
          allowed = isInboundDataChannelMessageAllowed(
            message,
            channelKind,
            role,
            controlAllowed,
          )
        }, context).not.toThrow()
        if (!allowed) continue
        const where = `${context} kind=${channelKind} role=${role} control=${controlAllowed}`
        if (channelKind === 'pointer') {
          expect(role, where).toBe('host')
          expect(controlAllowed, where).toBe(true)
          expect(
            message.type === 'control.event' && message.event.kind === 'pointer.move',
            where,
          ).toBe(true)
        }
        if (role === 'guest') {
          expect(OPERATOR_COMMANDS.has(message.type), where).toBe(false)
        }
        if (message.type === 'control.event') {
          expect(role === 'host' && controlAllowed, where).toBe(true)
        }
        if (message.type === 'control.granted') {
          expect(role === 'guest' && controlAllowed, where).toBe(true)
        }
      }
    }
  }
}

describe('DataChannel parser fuzz matrix', () => {
  it('accepts every valid seed exactly and keeps the authorization matrix', () => {
    for (const seed of DATA_CHANNEL_SEEDS) {
      const text = JSON.stringify(seed)
      const result = parseWithoutThrowing(text, text)
      expect(result, text).not.toBeNull()
      expect(canonicalJson(result)).toBe(canonicalJson(seed))
      assertAuthorizationMatrix(result as DataChannelMessage, text)
    }
  })

  it('never throws on arbitrary text or JSON and never rewrites accepted input', () => {
    const random = new SeededRandom(FUZZ_SEED)
    for (let iteration = 0; iteration < RANDOM_ITERATIONS; iteration += 1) {
      const value = cloneJson(randomJsonValue(random))
      const text = random.chance(0.3) ? randomString(random) : JSON.stringify(value)
      const context = `seed=${FUZZ_SEED} iteration=${iteration}`
      const result = parseWithoutThrowing(text, context)
      if (result) {
        expect(canonicalJson(result), context).toBe(canonicalJson(JSON.parse(text)))
        assertAuthorizationMatrix(result, context)
      }
      for (const parse of [parsePeerSignal, parseNativeVideoSignalEnvelope]) {
        let signal: unknown = null
        expect(() => {
          signal = parse(value)
        }, context).not.toThrow()
        if (signal !== null) {
          expect(canonicalJson(signal), context).toBe(canonicalJson(value))
        }
      }
    }
    expect(polluted()).toBeUndefined()
  }, FUZZ_TEST_TIMEOUT_MS)

  it('rejects suspicious keys at every depth of every DataChannel message', () => {
    for (const seed of DATA_CHANNEL_SEEDS) {
      for (const path of objectPaths(seed)) {
        for (const key of SUSPICIOUS_KEYS) {
          const text = JSON.stringify(addOwnKey(seed, path, key, { [POLLUTION_MARKER]: true }))
          const context = `${text.slice(0, 80)} path=${JSON.stringify(path)} key=${JSON.stringify(key)}`
          expect(parseWithoutThrowing(text, context), context).toBeNull()
        }
      }
    }
    expect(polluted()).toBeUndefined()
  })

  it('never throws on mutations and accepts only exact, authorized-shaped messages', () => {
    const random = new SeededRandom(FUZZ_SEED ^ 0x77)
    DATA_CHANNEL_SEEDS.forEach((seed, seedIndex) => {
      for (let iteration = 0; iteration < MUTATIONS_PER_SEED; iteration += 1) {
        const mutated = cloneJson(mutateJson(random, seed))
        const text = JSON.stringify(mutated)
        const context = `seed=${FUZZ_SEED ^ 0x77} seedIndex=${seedIndex} iteration=${iteration}`
        const result = parseWithoutThrowing(text, context)
        if (result) {
          expect(canonicalJson(result), context).toBe(canonicalJson(mutated))
          assertAuthorizationMatrix(result, context)
        }
      }
    })
    expect(polluted()).toBeUndefined()
  }, FUZZ_TEST_TIMEOUT_MS)

  it('rejects unpaired surrogates in peer identifiers, labels and control text', () => {
    const lone = '\\ud800'
    const texts = [
      `{"type":"ping","id":"${lone}","sentAt":1}`,
      `{"channel":"session","version":2,"sequence":1,"type":"display.select","displayId":"d${lone}"}`,
      `{"channel":"session","version":2,"sequence":1,"type":"display.list","displays":` +
        `[{"id":"d","label":"${lone}","width":1,"height":1}],"selectedDisplayId":"d"}`,
      `{"channel":"control","version":1,"type":"control.event","sequence":1,"event":` +
        `{"kind":"keyboard.key","code":"KeyA","key":"${lone}","location":0,"down":true,"repeat":false}}`,
    ]
    for (const text of texts) {
      expect(parseWithoutThrowing(text, text), text).toBeNull()
    }
    expect(
      parseDataChannelMessage(
        '{"channel":"control","version":1,"type":"control.event","sequence":1,"event":' +
          '{"kind":"keyboard.key","code":"KeyA","key":"\\ud83d\\ude00","location":0,"down":true,"repeat":false}}',
      ),
    ).not.toBeNull()
  })

  it('bounds size and nesting before parsing peer data', () => {
    const oversized = JSON.stringify({ ...session, type: 'display.select', displayId: 'x' })
      .replace('"x"', `"${'ç'.repeat(2_100)}"`)
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(4_096)
    expect(parseWithoutThrowing(oversized, 'oversized')).toBeNull()
    // 4 KiB sınırının altında kalan derin girdi ayrıştırıcının iç yoluna ulaşır.
    const deep = `{"channel":"control","version":1,"type":"control.event","sequence":1,"event":${'['.repeat(1_000)}${']'.repeat(1_000)}}`
    expect(new TextEncoder().encode(deep).byteLength).toBeLessThanOrEqual(4_096)
    expect(parseWithoutThrowing(deep, 'deep')).toBeNull()
    for (const value of [undefined, null, 1, 'x', [], {}, Number.NaN]) {
      expect(parsePeerSignal(value)).toBeNull()
      expect(parseNativeVideoSignalEnvelope(value)).toBeNull()
    }
  })
})
