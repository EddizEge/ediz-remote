import {
  negotiationIdSchema,
  type PeerSignal,
} from '@ediz-remote/protocol'

export const MAX_PENDING_ICE_CANDIDATES = 64
export const MAX_PENDING_ICE_CANDIDATE_BYTES = 64 * 1024
export const MAX_LOCAL_ICE_SDP_BYTES = 60 * 1024
export const MAX_ICE_CANDIDATE_LENGTH = 4_096
export const MAX_ICE_USERNAME_FRAGMENT_LENGTH = 256
export const MAX_LOCAL_ICE_USERNAME_FRAGMENTS = 16

export type PendingIceCandidateEnqueueResult =
  | 'accepted'
  | 'epoch-mismatch'
  | 'overflow'

interface PendingIceCandidate {
  candidate: IceCandidatePayload
  bytes: number
}

export type IceCandidatePayload = Extract<
  PeerSignal,
  { kind: 'ice-candidate' }
>['candidate']

export class PendingIceCandidateQueue {
  private negotiationId: string | null = null
  private readonly candidates: PendingIceCandidate[] = []
  private totalBytes = 0

  beginNegotiation(negotiationId: string): void {
    if (this.negotiationId !== negotiationId) this.clear()
    this.negotiationId = negotiationId
  }

  tryEnqueue(
    negotiationId: string,
    candidate: IceCandidatePayload,
  ): PendingIceCandidateEnqueueResult {
    if (this.negotiationId === null) this.negotiationId = negotiationId
    if (this.negotiationId !== negotiationId) return 'epoch-mismatch'

    const bytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength
    if (
      this.candidates.length >= MAX_PENDING_ICE_CANDIDATES ||
      this.totalBytes + bytes > MAX_PENDING_ICE_CANDIDATE_BYTES
    ) {
      return 'overflow'
    }

    this.candidates.push({ candidate, bytes })
    this.totalBytes += bytes
    return 'accepted'
  }

  drain(negotiationId: string): IceCandidatePayload[] {
    if (this.negotiationId !== negotiationId) return []
    const candidates = this.candidates.map((entry) => entry.candidate)
    this.clear()
    return candidates
  }

  clear(): void {
    this.negotiationId = null
    this.candidates.length = 0
    this.totalBytes = 0
  }

  get size(): number {
    return this.candidates.length
  }

  get byteLength(): number {
    return this.totalBytes
  }
}

export interface LocalIceCandidateIdentity {
  candidate: string
  usernameFragment?: string | null
}

export interface LocalIceGenerationBinding {
  readonly negotiationId: string
  readonly usernameFragments: readonly string[]
}

export function bindLocalIceGeneration(
  negotiationId: string,
  sdp: string | null | undefined,
): LocalIceGenerationBinding | null {
  if (!negotiationIdSchema.safeParse(negotiationId).success) return null
  const usernameFragments = extractLocalIceUsernameFragments(sdp)
  if (!usernameFragments || usernameFragments.length === 0) return null
  return Object.freeze({
    negotiationId,
    usernameFragments: Object.freeze(usernameFragments),
  })
}

export function resolveLocalCandidateNegotiationId(
  binding: LocalIceGenerationBinding | null,
  candidate: LocalIceCandidateIdentity,
): string | null {
  if (!binding || candidate.candidate.length > MAX_ICE_CANDIDATE_LENGTH) return null
  const lineResult = extractCandidateIceUsernameFragment(candidate.candidate)
  if (!lineResult.valid) return null
  let usernameFragment = lineResult.value
  if (candidate.usernameFragment !== null && candidate.usernameFragment !== undefined) {
    if (!isStrictIceUsernameFragment(candidate.usernameFragment)) return null
    if (usernameFragment !== null && usernameFragment !== candidate.usernameFragment) {
      return null
    }
    usernameFragment = candidate.usernameFragment
  }
  return usernameFragment !== null &&
    binding.usernameFragments.includes(usernameFragment)
    ? binding.negotiationId
    : null
}

function extractLocalIceUsernameFragments(
  sdp: string | null | undefined,
): string[] | null {
  if (
    !sdp ||
    new TextEncoder().encode(sdp).byteLength > MAX_LOCAL_ICE_SDP_BYTES
  ) return null

  const result = new Set<string>()
  for (const line of sdp.split(/\r?\n/u)) {
    if (!line.startsWith('a=ice-ufrag:')) continue
    const candidate = line.slice('a=ice-ufrag:'.length)
    if (!isStrictIceUsernameFragment(candidate)) return null
    result.add(candidate)
    if (result.size > MAX_LOCAL_ICE_USERNAME_FRAGMENTS) return null
  }
  return [...result]
}

interface CandidateIceUsernameFragmentResult {
  valid: boolean
  value: string | null
}

function extractCandidateIceUsernameFragment(
  candidate: string,
): CandidateIceUsernameFragmentResult {
  if (!candidate || candidate.length > MAX_ICE_CANDIDATE_LENGTH) {
    return { valid: false, value: null }
  }
  const fields = candidate.trim().split(/\s+/u)
  let result: string | null = null
  for (let index = 0; index < fields.length; index += 1) {
    if (fields[index]?.toLowerCase() !== 'ufrag') continue
    if (index + 1 >= fields.length) return { valid: false, value: null }
    const value = fields[index + 1]
    if (!isStrictIceUsernameFragment(value)) return { valid: false, value: null }
    if (result !== null && result !== value) {
      return { valid: false, value: null }
    }
    result = value
    index += 1
  }
  return { valid: true, value: result }
}

function isStrictIceUsernameFragment(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 4 &&
    value.length <= MAX_ICE_USERNAME_FRAGMENT_LENGTH &&
    /^[A-Za-z0-9+/]+$/u.test(value)
}
