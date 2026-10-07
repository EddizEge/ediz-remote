import { createSecretKey } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { SIGNALING_PROTOCOL_VERSION } from '@ediz-remote/protocol'
import {
  SecurityAuditWriter,
  isSafeSecurityAuditBuildId,
} from './securityAudit.js'

const DEFAULT_AUDIT_DIRECTORY = './data/security-audit'
const DEFAULT_BUILD_ID = 'ediz-remote@0.1.0'
const DEFAULT_RETENTION_DAYS = 7
const MAX_KEY_FILE_BYTES = 4_096
const MIN_KEY_BYTES = 32
const CONFIGURATION_ERROR = 'Güvenlik audit yapılandırması geçersiz.'
const KEY_OPEN_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0) |
  (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0)

export async function loadSecurityAuditWriter(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SecurityAuditWriter | undefined> {
  try {
    const enabled = parseBoolean(
      environment.SIGNALING_AUDIT_ENABLED,
      environment.NODE_ENV === 'production',
    )
    if (!enabled) return undefined

    const keyFile = environment.SIGNALING_AUDIT_HMAC_KEY_FILE
    const directory =
      environment.SIGNALING_AUDIT_DIRECTORY ?? DEFAULT_AUDIT_DIRECTORY
    const buildId = environment.EDIZ_REMOTE_BUILD_ID ?? DEFAULT_BUILD_ID
    const retentionDays = parseInteger(
      environment.SIGNALING_AUDIT_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
      1,
      30,
    )
    if (!keyFile || !isSafeSecurityAuditBuildId(buildId)) {
      throw new Error(CONFIGURATION_ERROR)
    }

    let keyHandle: FileHandle | undefined
    let rawKeyBytes: Buffer | undefined
    try {
      const pathMetadataBeforeOpen = await lstat(keyFile, { bigint: true })
      if (
        !isRegularNonSymlink(pathMetadataBeforeOpen) ||
        !hasPrivateKeyPermissions(pathMetadataBeforeOpen)
      ) {
        throw new Error(CONFIGURATION_ERROR)
      }

      keyHandle = await open(keyFile, KEY_OPEN_FLAGS)
      const descriptorMetadata = await keyHandle.stat({ bigint: true })
      if (
        !descriptorMetadata.isFile() ||
        !hasPrivateKeyPermissions(descriptorMetadata) ||
        descriptorMetadata.size < BigInt(MIN_KEY_BYTES) ||
        descriptorMetadata.size > BigInt(MAX_KEY_FILE_BYTES)
      ) {
        throw new Error(CONFIGURATION_ERROR)
      }

      const pathMetadataAfterOpen = await lstat(keyFile, { bigint: true })
      if (
        !isRegularNonSymlink(pathMetadataAfterOpen) ||
        !hasPrivateKeyPermissions(pathMetadataAfterOpen) ||
        !isSameFile(pathMetadataBeforeOpen, descriptorMetadata) ||
        !isSameFile(descriptorMetadata, pathMetadataAfterOpen)
      ) {
        throw new Error(CONFIGURATION_ERROR)
      }

      rawKeyBytes = Buffer.alloc(MAX_KEY_FILE_BYTES + 1)
      const bytesRead = await readBounded(keyHandle, rawKeyBytes)
      const { start, end } = trimAsciiWhitespace(rawKeyBytes, bytesRead)
      const keyLength = end - start
      if (
        bytesRead > MAX_KEY_FILE_BYTES ||
        keyLength < MIN_KEY_BYTES ||
        keyLength > MAX_KEY_FILE_BYTES
      ) {
        throw new Error(CONFIGURATION_ERROR)
      }

      const ipBucketKey = createSecretKey(rawKeyBytes.subarray(start, end))
      return new SecurityAuditWriter({
        directory,
        ipBucketKey,
        buildId,
        protocolVersion: SIGNALING_PROTOCOL_VERSION,
        retentionDays,
      })
    } finally {
      rawKeyBytes?.fill(0)
      await keyHandle?.close()
    }
  } catch {
    throw new Error(CONFIGURATION_ERROR)
  }
}

function isRegularNonSymlink(metadata: BigIntStats): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n
}

function hasPrivateKeyPermissions(metadata: BigIntStats): boolean {
  if (process.platform === 'win32') return true
  if (typeof process.getuid !== 'function') return false
  return (
    (metadata.mode & 0o077n) === 0n &&
    metadata.uid === BigInt(process.getuid())
  )
}

function isSameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function readBounded(
  handle: FileHandle,
  destination: Buffer,
): Promise<number> {
  let totalBytesRead = 0
  while (totalBytesRead < destination.length) {
    const { bytesRead } = await handle.read(
      destination,
      totalBytesRead,
      destination.length - totalBytesRead,
      null,
    )
    if (bytesRead === 0) break
    totalBytesRead += bytesRead
  }
  return totalBytesRead
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
  return (
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0b ||
    value === 0x0c ||
    value === 0x0d ||
    value === 0x20
  )
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(CONFIGURATION_ERROR)
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new Error(CONFIGURATION_ERROR)
  const parsed = Number.parseInt(value, 10)
  if (parsed < minimum || parsed > maximum) {
    throw new Error(CONFIGURATION_ERROR)
  }
  return parsed
}
