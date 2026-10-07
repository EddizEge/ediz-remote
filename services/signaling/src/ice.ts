import { createHmac } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from 'node:fs'
import type { IceConfiguration, IceServer } from '@ediz-remote/protocol'

const DEFAULT_STUN_URL = 'stun:stun.cloudflare.com:3478'
const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS = 60 * 60
const MIN_TURN_CREDENTIAL_TTL_SECONDS = 60
const MAX_TURN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60
const STUN_URL_PATTERN = /^stuns?:/i
const TURN_URL_PATTERN = /^turns?:/i
const MIN_TURN_SECRET_BYTES = 32
const MAX_TURN_SECRET_BYTES = 4_096
const TURN_SECRET_PATTERN = /^[A-Za-z0-9_+/=-]+$/u
const TURN_SECRET_CONFIGURATION_ERROR =
  'TURN secret yapılandırması geçersiz.'
const SECRET_OPEN_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0) |
  (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0)

export interface IceServiceOptions {
  stunUrls: string[]
  turnUrls: string[]
  turnSharedSecret?: string
  turnCredentialTtlSeconds: number
}

export function loadIceServiceOptions(
  environment: NodeJS.ProcessEnv = process.env,
): IceServiceOptions {
  const stunUrls = parseUrlList(
    environment.ICE_STUN_URLS,
    [DEFAULT_STUN_URL],
    STUN_URL_PATTERN,
  )
  const turnUrls = parseUrlList(
    environment.TURN_URLS,
    [],
    TURN_URL_PATTERN,
  )
  const turnSharedSecret = loadTurnSharedSecret(environment)
  const turnCredentialTtlSeconds = parseCredentialTtl(
    environment.TURN_CREDENTIAL_TTL_SECONDS,
  )

  if ((turnUrls.length > 0) !== Boolean(turnSharedSecret)) {
    throw new Error(
      'TURN_URLS ve TURN_SHARED_SECRET birlikte yapılandırılmalıdır.',
    )
  }
  if (
    turnSharedSecret &&
    (Buffer.byteLength(turnSharedSecret, 'utf8') < MIN_TURN_SECRET_BYTES ||
      Buffer.byteLength(turnSharedSecret, 'utf8') > MAX_TURN_SECRET_BYTES ||
      !TURN_SECRET_PATTERN.test(turnSharedSecret) ||
      turnSharedSecret === 'replace-with-a-long-random-secret')
  ) {
    throw new Error(
      'TURN_SHARED_SECRET en az 32 karakterlik rastgele bir değer olmalıdır.',
    )
  }
  if (stunUrls.length === 0 && turnUrls.length === 0) {
    throw new Error('En az bir STUN veya TURN URL yapılandırılmalıdır.')
  }

  return {
    stunUrls,
    turnUrls,
    turnSharedSecret,
    turnCredentialTtlSeconds,
  }
}

function loadTurnSharedSecret(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const inlineSecret = environment.TURN_SHARED_SECRET?.trim() || undefined
  const secretFile = environment.TURN_SHARED_SECRET_FILE?.trim() || undefined
  if (inlineSecret && secretFile) {
    throw new Error(TURN_SECRET_CONFIGURATION_ERROR)
  }
  if (!secretFile) return inlineSecret

  let descriptor: number | undefined
  let bytes: Buffer | undefined
  try {
    const beforeOpen = lstatSync(secretFile, { bigint: true })
    if (!isSafeSecretFile(beforeOpen)) {
      throw new Error(TURN_SECRET_CONFIGURATION_ERROR)
    }
    descriptor = openSync(secretFile, SECRET_OPEN_FLAGS)
    const opened = fstatSync(descriptor, { bigint: true })
    const afterOpen = lstatSync(secretFile, { bigint: true })
    if (
      !isSafeSecretFile(opened) ||
      !isSafeSecretFile(afterOpen) ||
      !isSameFile(beforeOpen, opened) ||
      !isSameFile(opened, afterOpen) ||
      opened.size < BigInt(MIN_TURN_SECRET_BYTES) ||
      opened.size > BigInt(MAX_TURN_SECRET_BYTES)
    ) {
      throw new Error(TURN_SECRET_CONFIGURATION_ERROR)
    }

    bytes = Buffer.alloc(MAX_TURN_SECRET_BYTES + 1)
    let total = 0
    while (total < bytes.length) {
      const read = readSync(descriptor, bytes, total, bytes.length - total, null)
      if (read === 0) break
      total += read
    }
    const { start, end } = trimAsciiWhitespace(bytes, total)
    if (
      total > MAX_TURN_SECRET_BYTES ||
      end - start < MIN_TURN_SECRET_BYTES
    ) {
      throw new Error(TURN_SECRET_CONFIGURATION_ERROR)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(start, end),
    )
  } catch {
    throw new Error(TURN_SECRET_CONFIGURATION_ERROR)
  } finally {
    bytes?.fill(0)
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // Ana yapılandırma sonucu sabit hata sözleşmesini korur.
      }
    }
  }
}

function isSafeSecretFile(
  metadata: BigIntStats,
): boolean {
  const currentUserId = typeof process.getuid === 'function'
    ? BigInt(process.getuid())
    : null
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1n &&
    (process.platform === 'win32' || (
      (metadata.mode & 0o077n) === 0n &&
      currentUserId !== null &&
      metadata.uid === currentUserId
    ))
  )
}

function isSameFile(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function trimAsciiWhitespace(
  value: Buffer,
  length: number,
): { start: number; end: number } {
  let start = 0
  let end = length
  while (start < end && isAsciiWhitespace(value[start]!)) start += 1
  while (end > start && isAsciiWhitespace(value[end - 1]!)) end -= 1
  return { start, end }
}

function isAsciiWhitespace(value: number): boolean {
  return [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20].includes(value)
}

export function createIceConfiguration(
  clientId: string,
  nowMilliseconds: number,
  options: IceServiceOptions,
): IceConfiguration {
  const iceServers: IceServer[] = []
  if (options.stunUrls.length > 0) {
    iceServers.push({ urls: [...options.stunUrls] })
  }

  if (options.turnUrls.length === 0 || !options.turnSharedSecret) {
    return { version: 1, expiresAt: null, iceServers }
  }

  const expiresAtSeconds =
    Math.floor(nowMilliseconds / 1_000) + options.turnCredentialTtlSeconds
  const username = `${expiresAtSeconds}:${clientId}`
  const credential = createHmac('sha1', options.turnSharedSecret)
    .update(username)
    .digest('base64')
  iceServers.push({
    urls: [...options.turnUrls],
    username,
    credential,
  })

  return {
    version: 1,
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
    iceServers,
  }
}

function parseUrlList(
  value: string | undefined,
  fallback: string[],
  pattern: RegExp,
): string[] {
  const urls =
    value === undefined
      ? fallback
      : value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
  if (urls.length > 4 || urls.some((url) => !pattern.test(url))) {
    throw new Error('ICE URL listesi geçersiz veya desteklenen sınırı aşıyor.')
  }
  return urls
}

function parseCredentialTtl(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_TURN_CREDENTIAL_TTL_SECONDS
  }
  const seconds = Number(value)
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_TURN_CREDENTIAL_TTL_SECONDS ||
    seconds > MAX_TURN_CREDENTIAL_TTL_SECONDS
  ) {
    throw new Error(
      `TURN_CREDENTIAL_TTL_SECONDS ${MIN_TURN_CREDENTIAL_TTL_SECONDS}-${MAX_TURN_CREDENTIAL_TTL_SECONDS} aralığında olmalıdır.`,
    )
  }
  return seconds
}
