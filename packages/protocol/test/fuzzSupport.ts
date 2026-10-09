// Seed'li ve bağımlılıksız fuzz yardımcıları. Aynı seed aynı girdi dizisini
// üretir; başarısız bir durum seed ve iterasyon numarasıyla yeniden üretilir.
// Signaling testleri de bu dosyayı göreli yolla kullanır.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }
export type JsonPath = Array<string | number>

/** mulberry32: küçük, deterministik ve fuzz için yeterince dağınık PRNG. */
export class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }

  integer(maximumExclusive: number): number {
    return Math.floor(this.next() * maximumExclusive)
  }

  pick<T>(values: readonly T[]): T {
    return values[this.integer(values.length)] as T
  }

  chance(probability: number): boolean {
    return this.next() < probability
  }
}

/** Strict şemalarda hiçbir derinlikte kabul edilmemesi gereken anahtarlar. */
export const SUSPICIOUS_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__defineGetter__',
  'then',
  '',
  ' type',
  'TYPE',
  '__unexpected',
] as const

const PROTOCOL_KEYS = [
  'type',
  'code',
  'payload',
  'kind',
  'negotiationId',
  'description',
  'sdp',
  'candidate',
  'channel',
  'version',
  'signal',
  'event',
  'sequence',
  'token',
  'requestId',
  'approved',
  'accessMode',
  'x',
  'y',
  'button',
  'down',
  'iceServers',
  'urls',
] as const

const PROTOCOL_STRINGS = [
  'ping',
  'signal',
  'create_session',
  'join_session',
  'resume_session',
  'refresh_ice',
  'revoke_control',
  'leave_session',
  'request_decision',
  'control',
  'control.event',
  'control.request',
  'pointer.move',
  'keyboard.key',
  'session-description',
  'ice-candidate',
  'native-video',
  'offer',
  'answer',
  'view',
] as const

const INTERESTING_STRINGS = [
  '',
  ' ',
  '0',
  '-1',
  'null',
  'undefined',
  'true',
  'NaN',
  'Infinity',
  '__proto__',
  'constructor',
  '\u0000',
  '\u0007',
  ' ',
  '\ud800',
  '\udfff',
  '￿',
  '\u{1F600}',
  'İıŞşĞğÇçÖöÜü',
  '"',
  '\\',
  '\r\n',
  '<script>',
  '../..',
  'ediz-remote.v3',
  '11111111-1111-4111-8111-111111111111',
  '123456',
  'stun:example.invalid',
  'turn:example.invalid:3478',
  'candidate:1 1 udp 1 192.0.2.1 9 typ host',
  'v=0',
  'x'.repeat(65),
  'x'.repeat(513),
  'y'.repeat(4_097),
] as const

const INTERESTING_NUMBERS = [
  0,
  -0,
  1,
  -1,
  2,
  3,
  4,
  0.5,
  1.5,
  -0.0001,
  1.0000001,
  65_535,
  65_536,
  10_000.5,
  2 ** 31,
  -(2 ** 31),
  2 ** 53,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  Number.MIN_VALUE,
  1e308,
  -1e308,
] as const

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Atama `__proto__` için prototipi değiştirir; daima kendi özelliği oluşturur. */
export function defineOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/** Wire ile aynı yol: JSON metni üzerinden kopyalar; kendi `__proto__` korunur. */
export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Anahtar sırasından bağımsız karşılaştırma için kanonik JSON metni. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      defineOwn(sorted, key, sortKeys((value as Record<string, unknown>)[key]))
    }
    return sorted
  }
  return value
}

export function randomString(random: SeededRandom): string {
  const roll = random.next()
  if (roll < 0.35) return random.pick(INTERESTING_STRINGS)
  if (roll < 0.55) return random.pick(PROTOCOL_STRINGS)
  const length = random.integer(24)
  let text = ''
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(
      random.chance(0.85) ? 0x20 + random.integer(0x5f) : random.integer(0x1_0000),
    )
  }
  return text
}

function randomKey(random: SeededRandom): string {
  const roll = random.next()
  if (roll < 0.5) return random.pick(PROTOCOL_KEYS)
  if (roll < 0.7) return random.pick(SUSPICIOUS_KEYS)
  return randomString(random)
}

export function randomNumber(random: SeededRandom): number {
  if (random.chance(0.6)) return random.pick(INTERESTING_NUMBERS)
  return (random.next() - 0.5) * 2 ** random.integer(64)
}

export function randomJsonValue(random: SeededRandom, depth = 0): JsonValue {
  switch (random.integer(depth >= 4 ? 4 : 6)) {
    case 0:
      return null
    case 1:
      return random.chance(0.5)
    case 2:
      return randomNumber(random)
    case 3:
      return randomString(random)
    case 4: {
      const items: JsonValue[] = []
      const length = random.integer(5)
      for (let index = 0; index < length; index += 1) {
        items.push(randomJsonValue(random, depth + 1))
      }
      return items
    }
    default: {
      const value: JsonObject = {}
      const size = random.integer(5)
      for (let index = 0; index < size; index += 1) {
        defineOwn(value, randomKey(random), randomJsonValue(random, depth + 1))
      }
      return value
    }
  }
}

export function collectPaths(value: JsonValue): JsonPath[] {
  const paths: JsonPath[] = []
  const pending: Array<{ value: JsonValue; path: JsonPath }> = [{ value, path: [] }]
  while (pending.length > 0) {
    const current = pending.pop() as { value: JsonValue; path: JsonPath }
    paths.push(current.path)
    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => {
        pending.push({ value: item, path: [...current.path, index] })
      })
    } else if (isJsonObject(current.value)) {
      for (const key of Object.keys(current.value)) {
        pending.push({
          value: current.value[key] as JsonValue,
          path: [...current.path, key],
        })
      }
    }
  }
  return paths
}

export function objectPaths(value: JsonValue): JsonPath[] {
  return collectPaths(value).filter((path) => isJsonObject(getAt(value, path)))
}

export function getAt(value: JsonValue, path: JsonPath): JsonValue {
  let current: JsonValue = value
  for (const segment of path) {
    current = (current as Record<string | number, JsonValue>)[segment] as JsonValue
  }
  return current
}

/** `path` konumundaki değeri değiştirilmiş bir kopya döndürür. */
export function replaceAt(root: JsonValue, path: JsonPath, value: JsonValue): JsonValue {
  if (path.length === 0) return cloneJson(value)
  const copy = cloneJson(root)
  const parent = getAt(copy, path.slice(0, -1)) as Record<string | number, JsonValue>
  defineOwn(parent, String(path[path.length - 1]), value)
  return copy
}

/** Nesne konumundan anahtarı silinmiş bir kopya döndürür. */
export function deleteAt(root: JsonValue, path: JsonPath): JsonValue {
  const copy = cloneJson(root)
  const parent = getAt(copy, path.slice(0, -1))
  const key = path[path.length - 1]
  if (Array.isArray(parent) && typeof key === 'number') {
    parent.splice(key, 1)
  } else if (isJsonObject(parent) && key !== undefined) {
    delete parent[String(key)]
  }
  return copy
}

/** `objectPath` nesnesine kendi özelliği olarak yeni anahtar eklenmiş kopya. */
export function addOwnKey(
  root: JsonValue,
  objectPath: JsonPath,
  key: string,
  value: JsonValue,
): JsonValue {
  const copy = cloneJson(root)
  defineOwn(getAt(copy, objectPath) as object, key, value)
  return copy
}

/** Geçerli bir seed'e tek bir rastgele yapısal/değer mutasyonu uygular. */
export function mutateJson(random: SeededRandom, seed: JsonValue): JsonValue {
  const paths = collectPaths(seed)
  const path = random.pick(paths)
  const current = getAt(seed, path)
  switch (random.integer(7)) {
    case 0:
      return replaceAt(seed, path, randomJsonValue(random, 2))
    case 1:
      return path.length > 0 ? deleteAt(seed, path) : randomJsonValue(random)
    case 2: {
      const objects = objectPaths(seed)
      if (objects.length === 0) return randomJsonValue(random)
      return addOwnKey(seed, random.pick(objects), randomKey(random), randomJsonValue(random, 3))
    }
    case 3:
      return replaceAt(seed, path, random.chance(0.5) ? randomNumber(random) : randomString(random))
    case 4: {
      const wrapped = cloneJson(current)
      return replaceAt(seed, path, random.chance(0.5) ? [wrapped] : { value: wrapped })
    }
    case 5:
      if (typeof current === 'string') {
        return replaceAt(seed, path, current.repeat(2 + random.integer(200)))
      }
      if (Array.isArray(current)) {
        return replaceAt(seed, path, cloneJson([...current, ...current, ...current]))
      }
      return replaceAt(seed, path, null)
    default: {
      const swapped = random.pick(paths)
      return replaceAt(seed, path, cloneJson(getAt(seed, swapped)))
    }
  }
}

/** `depth` seviye iç içe dizi; JSON.parse ile üretmek yığın kullanmaz. */
export function deeplyNestedArray(depth: number): JsonValue {
  return JSON.parse(`${'['.repeat(depth)}null${']'.repeat(depth)}`) as JsonValue
}
