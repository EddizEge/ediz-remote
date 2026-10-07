export interface TokenBucketLimit {
  capacity: number
  refillPerSecond: number
}

interface TokenBucketState {
  tokens: number
  updatedAt: number
}

interface SubjectState {
  lastSeenAt: number
  buckets: Map<string, TokenBucketState>
}

export class BoundedTokenBucketStore {
  readonly #subjects = new Map<string, SubjectState>()

  constructor(
    readonly maxSubjects: number,
    readonly idleTtlMs: number,
  ) {
    if (!Number.isInteger(maxSubjects) || maxSubjects < 1) {
      throw new Error('maxSubjects pozitif bir tam sayı olmalıdır.')
    }
    if (!Number.isFinite(idleTtlMs) || idleTtlMs < 1_000) {
      throw new Error('idleTtlMs en az 1000 olmalıdır.')
    }
  }

  consume(
    subject: string,
    bucketName: string,
    limit: TokenBucketLimit,
    timestamp: number,
    cost = 1,
  ): boolean {
    if (!subject || !bucketName) return false
    if (!isValidTokenBucketLimit(limit)) return false
    if (!Number.isFinite(timestamp) || !Number.isFinite(cost) || cost <= 0) {
      return false
    }

    let subjectState = this.#subjects.get(subject)
    if (!subjectState) {
      this.sweep(timestamp)
      if (this.#subjects.size >= this.maxSubjects) return false
      subjectState = { lastSeenAt: timestamp, buckets: new Map() }
      this.#subjects.set(subject, subjectState)
    }

    subjectState.lastSeenAt = Math.max(subjectState.lastSeenAt, timestamp)
    let bucket = subjectState.buckets.get(bucketName)
    if (!bucket) {
      bucket = { tokens: limit.capacity, updatedAt: timestamp }
      subjectState.buckets.set(bucketName, bucket)
    } else if (timestamp > bucket.updatedAt) {
      const elapsedSeconds = (timestamp - bucket.updatedAt) / 1_000
      bucket.tokens = Math.min(
        limit.capacity,
        bucket.tokens + elapsedSeconds * limit.refillPerSecond,
      )
      bucket.updatedAt = timestamp
    }

    if (bucket.tokens < cost) return false
    bucket.tokens -= cost
    return true
  }

  delete(subject: string): void {
    this.#subjects.delete(subject)
  }

  sweep(timestamp: number): number {
    let removed = 0
    for (const [subject, state] of this.#subjects) {
      if (timestamp - state.lastSeenAt < this.idleTtlMs) continue
      this.#subjects.delete(subject)
      removed += 1
    }
    return removed
  }

  get size(): number {
    return this.#subjects.size
  }
}

export function isValidTokenBucketLimit(limit: TokenBucketLimit): boolean {
  return (
    Number.isFinite(limit.capacity) &&
    limit.capacity >= 1 &&
    Number.isFinite(limit.refillPerSecond) &&
    limit.refillPerSecond > 0
  )
}
