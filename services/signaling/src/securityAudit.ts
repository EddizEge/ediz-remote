import { createHmac, createSecretKey, type KeyObject } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { isIP } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, parse, relative, resolve, sep } from 'node:path'

export const SECURITY_AUDIT_EVENT_TYPES = [
  'upgrade_rejected',
  'join_rate_limited',
  'join_rejected',
  'approval_granted',
  'approval_rejected',
  'resume_rejected',
  'resume_succeeded',
  'control_revoked',
  'session_ended',
] as const

export const SECURITY_AUDIT_OUTCOMES = [
  'allowed',
  'rejected',
  'rate_limited',
  'ended',
] as const

export const SECURITY_AUDIT_ROLES = [
  'host',
  'guest',
  'system',
  'unknown',
] as const

export const SECURITY_AUDIT_REASON_CODES = [
  'invalid_origin',
  'unsupported_protocol',
  'invalid_or_expired',
  'session_busy',
  'invalid_resume',
  'rate_limited',
  'host_decision',
  'host_request',
  'active_takeover',
  'grace_recovery',
  'host_left',
  'expired',
  'replaced',
  'reconnect_timeout',
  'guest_left',
  'server_shutdown',
] as const

export type SecurityAuditEventType =
  (typeof SECURITY_AUDIT_EVENT_TYPES)[number]
export type SecurityAuditOutcome = (typeof SECURITY_AUDIT_OUTCOMES)[number]
export type SecurityAuditRole = (typeof SECURITY_AUDIT_ROLES)[number]
export type SecurityAuditReasonCode =
  (typeof SECURITY_AUDIT_REASON_CODES)[number]

declare const coarseClientBucketBrand: unique symbol

/**
 * An opaque, daily-rotating pseudonym. Callers cannot pass a raw address where
 * this type is required without deliberately bypassing the type system.
 */
export type CoarseClientBucket = string & {
  readonly [coarseClientBucketBrand]: true
}

interface ClientBucketField {
  readonly coarseClientBucket: CoarseClientBucket | null
}

export type SecurityAuditEventInput = ClientBucketField &
  (
    | {
        readonly eventType: 'upgrade_rejected'
        readonly outcome: 'rejected'
        readonly role: 'unknown'
        readonly reasonCode: 'invalid_origin' | 'unsupported_protocol'
      }
    | {
        readonly eventType: 'join_rate_limited'
        readonly outcome: 'rate_limited'
        readonly role: 'unknown'
        readonly reasonCode: 'rate_limited'
      }
    | {
        readonly eventType: 'join_rejected'
        readonly outcome: 'rejected'
        readonly role: 'unknown'
        readonly reasonCode: 'invalid_or_expired' | 'session_busy'
      }
    | {
        readonly eventType: 'approval_granted'
        readonly outcome: 'allowed'
        readonly role: 'host'
        readonly reasonCode: 'host_decision'
      }
    | {
        readonly eventType: 'approval_rejected'
        readonly outcome: 'rejected'
        readonly role: 'host'
        readonly reasonCode: 'host_decision'
      }
    | {
        readonly eventType: 'resume_rejected'
        readonly outcome: 'rejected' | 'rate_limited'
        readonly role: 'unknown'
        readonly reasonCode: 'invalid_resume' | 'rate_limited'
      }
    | {
        readonly eventType: 'resume_succeeded'
        readonly outcome: 'allowed'
        readonly role: 'host' | 'guest'
        readonly reasonCode: 'active_takeover' | 'grace_recovery'
      }
    | {
        readonly eventType: 'control_revoked'
        readonly outcome: 'allowed'
        readonly role: 'host'
        readonly reasonCode: 'host_request'
      }
    | {
        readonly eventType: 'session_ended'
        readonly outcome: 'ended'
        readonly role: 'host'
        readonly reasonCode: 'host_left'
      }
    | {
        readonly eventType: 'session_ended'
        readonly outcome: 'ended'
        readonly role: 'guest'
        readonly reasonCode: 'guest_left'
      }
    | {
        readonly eventType: 'session_ended'
        readonly outcome: 'ended'
        readonly role: 'system'
        readonly reasonCode:
          | 'expired'
          | 'replaced'
          | 'reconnect_timeout'
          | 'server_shutdown'
      }
  )

type ExactSecurityAuditEvent<T extends SecurityAuditEventInput> = T &
  Record<Exclude<keyof T, keyof SecurityAuditEventInput>, never>

export interface SecurityAuditWriterOptions {
  /** Trusted deployment path; it is never copied into an audit event. */
  readonly directory: string
  /** A non-exported symmetric key keeps the HMAC secret out of string APIs. */
  readonly ipBucketKey: KeyObject
  readonly buildId: string
  readonly protocolVersion: number
  readonly retentionDays?: number
  readonly maxQueueEntries?: number
  readonly now?: () => Date
}

export type SecurityAuditRejectReason =
  | 'invalid_event'
  | 'emission_limited'
  | 'queue_full'
  | 'writer_unavailable'
  | 'closed'

export type SecurityAuditEnqueueResult =
  | { readonly accepted: true }
  | {
      readonly accepted: false
      readonly reason: SecurityAuditRejectReason
    }

export type SecurityAuditErrorCode =
  | 'audit_queue_overflow'
  | 'audit_invalid_event'
  | 'audit_write_failed'

export interface SecurityAuditFlushResult {
  readonly ok: boolean
  readonly errorCode: SecurityAuditErrorCode | null
  readonly droppedEntries: number
}

export interface SecurityAuditStatus extends SecurityAuditFlushResult {
  readonly pendingEntries: number
  readonly suppressedEntries: number
  readonly writeFailures: number
  readonly closed: boolean
}

interface QueuedAuditLine {
  readonly day: string
  readonly line: string
  readonly critical: boolean
}

const DEFAULT_RETENTION_DAYS = 7
const DEFAULT_MAX_QUEUE_ENTRIES = 512
const MAX_QUEUE_ENTRIES = 10_000
const MIN_HMAC_KEY_BYTES = 32
const BUILD_ID_PATTERN = /^ediz-remote@[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const CLIENT_BUCKET_PATTERN = /^ip1_[A-Za-z0-9_-]{16}$/
const AUDIT_FILE_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/
const AUDIT_EVENT_KEYS = new Set([
  'eventType',
  'outcome',
  'role',
  'reasonCode',
  'coarseClientBucket',
])
const EVENT_TYPES = new Set<string>(SECURITY_AUDIT_EVENT_TYPES)
const OUTCOMES = new Set<string>(SECURITY_AUDIT_OUTCOMES)
const ROLES = new Set<string>(SECURITY_AUDIT_ROLES)
const REASON_CODES = new Set<string>(SECURITY_AUDIT_REASON_CODES)
const IP_BUCKET_DOMAIN = 'ediz-remote/security-audit/ip-bucket/v1'
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000
const EMISSION_CAPACITY = 64
const EMISSION_REFILL_PER_SECOND = 0.5
const MAX_ISSUED_BUCKETS = 8_192

export function isSafeSecurityAuditBuildId(value: unknown): value is string {
  return typeof value === 'string' && BUILD_ID_PATTERN.test(value)
}

/**
 * Bounded, non-blocking JSONL writer for privacy-preserving security events.
 * It never accepts free-form event strings, payloads, exceptions, identifiers,
 * tokens, codes, SDP/ICE, credentials, or raw client addresses in record().
 */
export class SecurityAuditWriter {
  readonly #directory: string
  readonly #ipBucketRootKey: KeyObject
  readonly #buildId: string
  readonly #protocolVersion: number
  readonly #retentionDays: number
  readonly #maxQueueEntries: number
  readonly #noiseQueueLimit: number
  readonly #now: () => Date
  readonly #queue: QueuedAuditLine[] = []
  readonly #issuedBucketDays = new Map<string, string>()
  readonly #previousIssuedBuckets = new Set<string>()

  #directoryIdentity: Stats | undefined
  #worker: Promise<void> | undefined
  #retentionOperation: Promise<boolean> | undefined
  #retentionTimer: NodeJS.Timeout | undefined
  #retentionCheckedDay: string | undefined
  #bucketDay: string | undefined
  #dailyIpBucketKey: KeyObject | undefined
  #available = true
  #accepting = true
  #closed = false
  #queuedNoiseEntries = 0
  #droppedEntries = 0
  #suppressedEntries = 0
  #writeFailures = 0
  #lastErrorCode: SecurityAuditErrorCode | null = null
  #emissionTokens = EMISSION_CAPACITY
  #emissionUpdatedAt: number | undefined

  constructor(options: SecurityAuditWriterOptions) {
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS
    const maxQueueEntries =
      options.maxQueueEntries ?? DEFAULT_MAX_QUEUE_ENTRIES

    if (
      !safeAuditDirectory(options.directory) ||
      !isValidHmacKey(options.ipBucketKey) ||
      !isSafeSecurityAuditBuildId(options.buildId) ||
      !Number.isInteger(options.protocolVersion) ||
      options.protocolVersion < 1 ||
      options.protocolVersion > 255 ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 30 ||
      !Number.isInteger(maxQueueEntries) ||
      maxQueueEntries < 1 ||
      maxQueueEntries > MAX_QUEUE_ENTRIES ||
      (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw new Error('Geçersiz güvenlik audit yapılandırması.')
    }

    this.#directory = safeAuditDirectory(options.directory)!
    this.#ipBucketRootKey = options.ipBucketKey
    this.#buildId = options.buildId
    this.#protocolVersion = options.protocolVersion
    this.#retentionDays = retentionDays
    this.#maxQueueEntries = maxQueueEntries
    const criticalReserve = Math.max(
      1,
      Math.min(64, Math.ceil(maxQueueEntries / 4)),
    )
    this.#noiseQueueLimit = maxQueueEntries - criticalReserve
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * Converts a raw address into a daily pseudonym without retaining the address.
   * Invalid addresses return null and are never included in an error message.
   */
  bucketClientIp(clientIp: string): CoarseClientBucket | null {
    try {
      const canonicalIp = canonicalizeIp(clientIp)
      const currentDay = utcDay(this.#now())
      if (!canonicalIp || !currentDay) return null

      if (this.#bucketDay !== currentDay || !this.#dailyIpBucketKey) {
        this.#previousIssuedBuckets.clear()
        if (this.#bucketDay !== undefined) {
          for (const bucket of this.#issuedBucketDays.keys()) {
            this.#previousIssuedBuckets.add(bucket)
          }
        }
        this.#issuedBucketDays.clear()
        const derivedKey = createHmac('sha256', this.#ipBucketRootKey)
          .update(IP_BUCKET_DOMAIN, 'utf8')
          .update('\0', 'utf8')
          .update(currentDay, 'ascii')
          .digest()
        this.#dailyIpBucketKey = createSecretKey(derivedKey)
        derivedKey.fill(0)
        this.#bucketDay = currentDay
      }

      const digest = createHmac('sha256', this.#dailyIpBucketKey)
        .update(canonicalIp, 'ascii')
        .digest()
      const bucket = `ip1_${digest.subarray(0, 12).toString('base64url')}`
      digest.fill(0)
      if (
        !this.#issuedBucketDays.has(bucket) &&
        this.#issuedBucketDays.size >= MAX_ISSUED_BUCKETS
      ) {
        return null
      }
      this.#issuedBucketDays.set(bucket, currentDay)
      return bucket as CoarseClientBucket
    } catch {
      return null
    }
  }

  record<const T extends SecurityAuditEventInput>(
    event: ExactSecurityAuditEvent<T>,
  ): SecurityAuditEnqueueResult {
    if (this.#closed) return { accepted: false, reason: 'closed' }
    if (!this.#available || !this.#accepting) {
      return { accepted: false, reason: 'writer_unavailable' }
    }

    const parsed = parseAuditEvent(event)
    const timestamp = safeNow(this.#now)
    const day = timestamp ? utcDay(timestamp) : null
    if (!parsed || !timestamp || !day) {
      this.#markInvalidEvent()
      return { accepted: false, reason: 'invalid_event' }
    }

    let coarseClientBucket = parsed.coarseClientBucket
    if (coarseClientBucket) {
      const issuedDay = this.#issuedBucketDays.get(coarseClientBucket)
      if (!issuedDay) {
        if (this.#previousIssuedBuckets.has(coarseClientBucket)) {
          coarseClientBucket = null
        } else {
          this.#markInvalidEvent()
          return { accepted: false, reason: 'invalid_event' }
        }
      } else if (issuedDay !== day) {
        coarseClientBucket = null
      }
    }

    const critical = isCriticalAuditEvent(parsed.eventType)
    if (!critical) {
      if (
        !this.#consumeEmissionToken(timestamp.getTime()) ||
        this.#queuedNoiseEntries >= this.#noiseQueueLimit
      ) {
        this.#suppressedEntries += 1
        return { accepted: false, reason: 'emission_limited' }
      }
    }

    if (this.#queue.length >= this.#maxQueueEntries) {
      if (critical) {
        const noiseIndex = this.#queue.findIndex((entry) => !entry.critical)
        if (noiseIndex >= 0) {
          this.#queue.splice(noiseIndex, 1)
          this.#queuedNoiseEntries -= 1
          this.#suppressedEntries += 1
        } else {
          this.#accepting = false
          this.#droppedEntries += 1
          this.#lastErrorCode = 'audit_queue_overflow'
          return { accepted: false, reason: 'queue_full' }
        }
      } else {
        this.#suppressedEntries += 1
        return { accepted: false, reason: 'emission_limited' }
      }
    }

    const line = `${JSON.stringify({
      timestamp: timestamp.toISOString(),
      eventType: parsed.eventType,
      outcome: parsed.outcome,
      role: parsed.role,
      reasonCode: parsed.reasonCode,
      coarseClientBucket,
      protocolVersion: this.#protocolVersion,
      buildId: this.#buildId,
    })}\n`

    this.#queue.push({ day, line, critical })
    if (!critical) this.#queuedNoiseEntries += 1
    this.#scheduleDrain()
    return { accepted: true }
  }

  /** Runs the daily retention sweep even when the service has no audit traffic. */
  async initialize(): Promise<SecurityAuditFlushResult> {
    if (!this.#available || !this.#accepting || this.#closed) {
      return this.#flushResult()
    }
    const timestamp = safeNow(this.#now)
    const day = timestamp ? utcDay(timestamp) : null
    if (!day) {
      this.#markWriteFailure()
      return this.#flushResult()
    }
    await this.#applyRetention(day)
    if (this.#available && this.#accepting && !this.#closed && !this.#retentionTimer) {
      this.#retentionTimer = setInterval(() => {
        const currentTimestamp = safeNow(this.#now)
        const currentDay = currentTimestamp ? utcDay(currentTimestamp) : null
        if (!currentDay) {
          this.#markWriteFailure()
          return
        }
        void this.#applyRetention(currentDay)
      }, RETENTION_SWEEP_INTERVAL_MS)
      this.#retentionTimer.unref()
    }
    return this.#flushResult()
  }

  async flush(): Promise<SecurityAuditFlushResult> {
    for (;;) {
      this.#scheduleDrain()
      const worker = this.#worker
      if (!worker) break
      await worker
      // Allow the worker's completion handler to publish a successor worker.
      await Promise.resolve()
    }
    const retentionOperation = this.#retentionOperation
    if (retentionOperation) await retentionOperation
    return this.#flushResult()
  }

  async close(): Promise<SecurityAuditFlushResult> {
    this.#closed = true
    if (this.#retentionTimer) {
      clearInterval(this.#retentionTimer)
      this.#retentionTimer = undefined
    }
    return this.flush()
  }

  get status(): SecurityAuditStatus {
    const flushResult = this.#flushResult()
    return {
      ...flushResult,
      ok:
        this.#available &&
        this.#accepting &&
        !this.#closed &&
        this.#lastErrorCode === null,
      pendingEntries: this.#queue.length,
      suppressedEntries: this.#suppressedEntries,
      writeFailures: this.#writeFailures,
      closed: this.#closed,
    }
  }

  #scheduleDrain(): void {
    if (
      this.#worker ||
      !this.#available ||
      this.#queue.length === 0
    ) {
      return
    }

    const worker = Promise.resolve()
      .then(() => this.#drainQueue())
      .catch(() => this.#markWriteFailure())
    this.#worker = worker
    void worker.then(() => {
      if (this.#worker === worker) this.#worker = undefined
      if (this.#available && this.#queue.length > 0) this.#scheduleDrain()
    })
  }

  async #drainQueue(): Promise<void> {
    while (this.#available && this.#queue.length > 0) {
      let removedCount = 0
      try {
        const next = this.#queue[0]
        if (!next) return
        if (!(await this.#applyRetention(next.day))) return

        const batch: QueuedAuditLine[] = []
        while (this.#queue[0]?.day === next.day) {
          const entry = this.#queue.shift()
          if (entry) {
            batch.push(entry)
            if (!entry.critical) this.#queuedNoiseEntries -= 1
          }
        }
        removedCount = batch.length
        const filePath = join(this.#directory, `audit-${next.day}.jsonl`)
        const created = await appendDurableAuditFile(
          filePath,
          batch.map((entry) => entry.line).join(''),
          () => this.#ensurePinnedAuditDirectory(),
        )
        if (created) {
          await syncAuditDirectory(
            this.#directory,
            this.#directoryIdentity,
          )
        }
      } catch {
        this.#markWriteFailure(removedCount)
      }
    }
  }

  async #applyRetention(currentDay: string): Promise<boolean> {
    if (this.#retentionCheckedDay === currentDay) {
      try {
        await this.#ensurePinnedAuditDirectory()
        return true
      } catch {
        this.#markWriteFailure()
        return false
      }
    }
    if (this.#retentionOperation) {
      const existingResult = await this.#retentionOperation
      if (!existingResult || !this.#available) return false
      if (this.#retentionCheckedDay === currentDay) return true
    }

    const operation = this.#performRetention(currentDay)
      .then(() => {
        this.#retentionCheckedDay = currentDay
        return true
      })
      .catch(() => {
        this.#markWriteFailure()
        return false
      })
    this.#retentionOperation = operation
    const result = await operation
    if (this.#retentionOperation === operation) {
      this.#retentionOperation = undefined
    }
    return result
  }

  async #performRetention(currentDay: string): Promise<void> {
    await this.#ensurePinnedAuditDirectory()

    const currentDayEpoch = parseUtcDay(currentDay)
    if (currentDayEpoch === null) {
      throw new Error('Geçersiz audit saati.')
    }
    const cutoff =
      currentDayEpoch - (this.#retentionDays - 1) * MILLISECONDS_PER_DAY

    const entries = await readdir(this.#directory, { withFileTypes: true })
    let deletedEntry = false
    for (const entry of entries) {
      const match = AUDIT_FILE_PATTERN.exec(entry.name)
      if (!match) continue
      if (entry.isSymbolicLink()) throw new Error('Güvensiz audit girdisi.')
      if (!entry.isFile()) throw new Error('Geçersiz audit girdisi.')
      const filePath = join(this.#directory, entry.name)
      const beforeDelete = await lstat(filePath)
      if (
        beforeDelete.isSymbolicLink() ||
        !beforeDelete.isFile() ||
        beforeDelete.nlink !== 1
      ) {
        throw new Error('Güvensiz audit girdisi.')
      }
      const fileDayEpoch = match?.[1] ? parseUtcDay(match[1]) : null
      if (fileDayEpoch === null || fileDayEpoch >= cutoff) continue
      await this.#ensurePinnedAuditDirectory()
      const immediatelyBeforeDelete = await lstat(filePath)
      if (
        immediatelyBeforeDelete.isSymbolicLink() ||
        !immediatelyBeforeDelete.isFile() ||
        immediatelyBeforeDelete.nlink !== 1 ||
        !isSameFile(beforeDelete, immediatelyBeforeDelete)
      ) {
        throw new Error('Güvensiz audit girdisi.')
      }
      await unlink(filePath)
      deletedEntry = true
    }
    await this.#ensurePinnedAuditDirectory()
    if (deletedEntry) {
      await syncAuditDirectory(this.#directory, this.#directoryIdentity)
    }
  }

  async #ensurePinnedAuditDirectory(): Promise<void> {
    const metadata = this.#directoryIdentity
      ? await inspectSafeAuditDirectory(
          this.#directory,
          this.#directoryIdentity,
        )
      : await ensureSafeAuditDirectory(this.#directory)
    if (
      this.#directoryIdentity &&
      !isSameFile(this.#directoryIdentity, metadata)
    ) {
      throw new Error('Güvensiz audit dizini.')
    }
    this.#directoryIdentity ??= metadata
  }

  #consumeEmissionToken(timestamp: number): boolean {
    if (this.#emissionUpdatedAt === undefined) {
      this.#emissionUpdatedAt = timestamp
    } else if (timestamp > this.#emissionUpdatedAt) {
      const elapsedSeconds = (timestamp - this.#emissionUpdatedAt) / 1_000
      this.#emissionTokens = Math.min(
        EMISSION_CAPACITY,
        this.#emissionTokens + elapsedSeconds * EMISSION_REFILL_PER_SECOND,
      )
      this.#emissionUpdatedAt = timestamp
    }
    if (this.#emissionTokens < 1) return false
    this.#emissionTokens -= 1
    return true
  }

  #markWriteFailure(removedCount = 0): void {
    if (!this.#available) return
    this.#available = false
    this.#accepting = false
    this.#writeFailures += 1
    this.#lastErrorCode = 'audit_write_failed'
    this.#droppedEntries += removedCount + this.#queue.length
    this.#queue.length = 0
    this.#queuedNoiseEntries = 0
  }

  #markInvalidEvent(): void {
    if (!this.#accepting) return
    this.#accepting = false
    this.#lastErrorCode = 'audit_invalid_event'
    this.#droppedEntries += 1
  }

  #flushResult(): SecurityAuditFlushResult {
    return {
      ok:
        this.#available &&
        this.#accepting &&
        this.#queue.length === 0 &&
        this.#lastErrorCode === null,
      errorCode: this.#lastErrorCode,
      droppedEntries: this.#droppedEntries,
    }
  }
}

function parseAuditEvent(value: unknown): SecurityAuditEventInput | null {
  try {
    if (!isPlainRecord(value)) return null
    const keys = Object.keys(value)
    if (
      keys.length !== AUDIT_EVENT_KEYS.size ||
      keys.some((key) => !AUDIT_EVENT_KEYS.has(key))
    ) {
      return null
    }

    const eventType = value.eventType
    const outcome = value.outcome
    const role = value.role
    const reasonCode = value.reasonCode
    const coarseClientBucket = value.coarseClientBucket
    if (
      typeof eventType !== 'string' ||
      !EVENT_TYPES.has(eventType) ||
      typeof outcome !== 'string' ||
      !OUTCOMES.has(outcome) ||
      typeof role !== 'string' ||
      !ROLES.has(role) ||
      typeof reasonCode !== 'string' ||
      !REASON_CODES.has(reasonCode) ||
      (coarseClientBucket !== null &&
        (typeof coarseClientBucket !== 'string' ||
          !CLIENT_BUCKET_PATTERN.test(coarseClientBucket))) ||
      !isValidAuditTuple(
        eventType as SecurityAuditEventType,
        outcome as SecurityAuditOutcome,
        role as SecurityAuditRole,
        reasonCode as SecurityAuditReasonCode,
      )
    ) {
      return null
    }

    return {
      eventType,
      outcome,
      role,
      reasonCode,
      coarseClientBucket: coarseClientBucket as CoarseClientBucket | null,
    } as SecurityAuditEventInput
  } catch {
    return null
  }
}

function isCriticalAuditEvent(eventType: SecurityAuditEventType): boolean {
  return (
    eventType === 'approval_granted' ||
    eventType === 'approval_rejected' ||
    eventType === 'resume_succeeded' ||
    eventType === 'control_revoked' ||
    eventType === 'session_ended'
  )
}

function isValidAuditTuple(
  eventType: SecurityAuditEventType,
  outcome: SecurityAuditOutcome,
  role: SecurityAuditRole,
  reasonCode: SecurityAuditReasonCode,
): boolean {
  switch (eventType) {
    case 'upgrade_rejected':
      return (
        outcome === 'rejected' &&
        role === 'unknown' &&
        (reasonCode === 'invalid_origin' ||
          reasonCode === 'unsupported_protocol')
      )
    case 'join_rate_limited':
      return (
        outcome === 'rate_limited' &&
        role === 'unknown' &&
        reasonCode === 'rate_limited'
      )
    case 'join_rejected':
      return (
        outcome === 'rejected' &&
        role === 'unknown' &&
        (reasonCode === 'invalid_or_expired' ||
          reasonCode === 'session_busy')
      )
    case 'approval_granted':
      return (
        outcome === 'allowed' &&
        role === 'host' &&
        reasonCode === 'host_decision'
      )
    case 'approval_rejected':
      return (
        outcome === 'rejected' &&
        role === 'host' &&
        reasonCode === 'host_decision'
      )
    case 'resume_rejected':
      return (
        role === 'unknown' &&
        ((outcome === 'rejected' && reasonCode === 'invalid_resume') ||
          (outcome === 'rate_limited' && reasonCode === 'rate_limited'))
      )
    case 'resume_succeeded':
      return (
        outcome === 'allowed' &&
        (role === 'host' || role === 'guest') &&
        (reasonCode === 'active_takeover' ||
          reasonCode === 'grace_recovery')
      )
    case 'control_revoked':
      return (
        outcome === 'allowed' &&
        role === 'host' &&
        reasonCode === 'host_request'
      )
    case 'session_ended':
      return (
        outcome === 'ended' &&
        ((role === 'host' && reasonCode === 'host_left') ||
          (role === 'guest' && reasonCode === 'guest_left') ||
          (role === 'system' &&
            (reasonCode === 'expired' ||
              reasonCode === 'replaced' ||
              reasonCode === 'reconnect_timeout' ||
              reasonCode === 'server_shutdown')))
      )
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function safeNow(now: () => Date): Date | null {
  try {
    const value = now()
    return value instanceof Date && Number.isFinite(value.getTime())
      ? new Date(value.getTime())
      : null
  } catch {
    return null
  }
}

function utcDay(date: Date): string | null {
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null
}

function parseUtcDay(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const epoch = Date.parse(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(epoch)) return null
  return new Date(epoch).toISOString().slice(0, 10) === day ? epoch : null
}

function canonicalizeIp(value: string): string | null {
  if (typeof value !== 'string') return null
  const version = isIP(value)
  if (version === 4) {
    return value
      .split('.')
      .map((part) => String(Number(part)))
      .join('.')
  }
  if (version !== 6) return null
  try {
    const hostname = new URL(`http://[${value}]/`).hostname
    return hostname.slice(1, -1).toLowerCase()
  } catch {
    return null
  }
}

function isValidHmacKey(value: unknown): value is KeyObject {
  try {
    if (value === null || typeof value !== 'object') return false
    const candidate = value as Partial<KeyObject>
    return (
      candidate.type === 'secret' &&
      typeof candidate.symmetricKeySize === 'number' &&
      candidate.symmetricKeySize >= MIN_HMAC_KEY_BYTES
    )
  } catch {
    return false
  }
}

function safeAuditDirectory(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes('\0')
  ) {
    return null
  }
  try {
    const resolved = resolve(value)
    const root = parse(resolved).root
    const components = relative(root, resolved).split(sep).filter(Boolean)
    const broadTargets = [root, process.cwd(), homedir(), tmpdir()].map((path) =>
      normalizePathForComparison(resolve(path)),
    )
    if (
      components.length < 2 ||
      broadTargets.includes(normalizePathForComparison(resolved))
    ) {
      return null
    }
    return resolved
  } catch {
    return null
  }
}

async function ensureSafeAuditDirectory(directory: string): Promise<Stats> {
  await verifyDirectoryComponents(directory, false)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return inspectSafeAuditDirectory(directory)
}

async function inspectSafeAuditDirectory(
  directory: string,
  expectedIdentity?: Stats,
  synchronize = false,
): Promise<Stats> {
  await verifyDirectoryComponents(directory, true)
  const beforeOpen = await lstat(directory)
  if (
    beforeOpen.isSymbolicLink() ||
    !beforeOpen.isDirectory() ||
    (expectedIdentity !== undefined &&
      !isSameFile(beforeOpen, expectedIdentity))
  ) {
    throw new Error('Güvensiz audit dizini.')
  }
  if (process.platform === 'win32') {
    const afterValidation = await lstat(directory)
    if (
      afterValidation.isSymbolicLink() ||
      !afterValidation.isDirectory() ||
      !isSameFile(beforeOpen, afterValidation) ||
      (expectedIdentity !== undefined &&
        !isSameFile(afterValidation, expectedIdentity))
    ) {
      throw new Error('Güvensiz audit dizini.')
    }
    return afterValidation
  }
  const noFollowFlag =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(directory, constants.O_RDONLY | noFollowFlag)
  try {
    const descriptorMetadata = await handle.stat()
    const pathMetadata = await lstat(directory)
    if (
      beforeOpen.isSymbolicLink() ||
      !beforeOpen.isDirectory() ||
      !descriptorMetadata.isDirectory() ||
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isDirectory() ||
      !isSameFile(beforeOpen, descriptorMetadata) ||
      !isSameFile(descriptorMetadata, pathMetadata) ||
      (expectedIdentity !== undefined &&
        !isSameFile(descriptorMetadata, expectedIdentity))
    ) {
      throw new Error('Güvensiz audit dizini.')
    }
    await handle.chmod(0o700)
    if (synchronize) await handle.sync()
    return descriptorMetadata
  } finally {
    await handle.close()
  }
}

async function syncAuditDirectory(
  directory: string,
  expectedIdentity: Stats | undefined,
): Promise<void> {
  if (!expectedIdentity) throw new Error('Güvensiz audit dizini.')
  await inspectSafeAuditDirectory(directory, expectedIdentity, true)
}

async function verifyDirectoryComponents(
  directory: string,
  requireEveryComponent: boolean,
): Promise<void> {
  const root = parse(directory).root
  const components = relative(root, directory).split(sep).filter(Boolean)
  let current = root
  for (const component of components) {
    current = join(current, component)
    let metadata
    try {
      metadata = await lstat(current)
    } catch (error) {
      if (!requireEveryComponent && isMissingFileError(error)) return
      throw error
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Güvensiz audit dizini.')
    }
  }
}

async function appendDurableAuditFile(
  filePath: string,
  contents: string,
  validateDirectory: () => Promise<void>,
): Promise<boolean> {
  const beforeOpen = await lstatIfExists(filePath)
  if (
    beforeOpen &&
    (beforeOpen.isSymbolicLink() ||
      !beforeOpen.isFile() ||
      beforeOpen.nlink !== 1)
  ) {
    throw new Error('Güvensiz audit dosyası.')
  }

  const noFollowFlag =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const created = beforeOpen === null
  const creationFlags = created
    ? constants.O_CREAT | constants.O_EXCL
    : 0
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_APPEND | creationFlags | noFollowFlag,
    0o600,
  )
  try {
    await validateDirectory()
    const descriptorMetadata = await handle.stat()
    const pathMetadata = await lstat(filePath)
    if (
      !descriptorMetadata.isFile() ||
      descriptorMetadata.nlink !== 1 ||
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      pathMetadata.nlink !== 1 ||
      !isSameFile(descriptorMetadata, pathMetadata) ||
      (beforeOpen !== null && !isSameFile(beforeOpen, descriptorMetadata))
    ) {
      throw new Error('Güvensiz audit dosyası.')
    }
    await handle.chmod(0o600)
    await handle.writeFile(contents, { encoding: 'utf8' })
    await handle.sync()
    const afterWrite = await lstat(filePath)
    if (
      afterWrite.isSymbolicLink() ||
      !afterWrite.isFile() ||
      afterWrite.nlink !== 1 ||
      !isSameFile(descriptorMetadata, afterWrite)
    ) {
      throw new Error('Güvensiz audit dosyası.')
    }
    await validateDirectory()
    return created
  } finally {
    await handle.close()
  }
}

async function lstatIfExists(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

function isSameFile(
  first: Awaited<ReturnType<typeof lstat>>,
  second: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function normalizePathForComparison(path: string): string {
  const normalized = path.endsWith(sep) ? path.slice(0, -1) : path
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
