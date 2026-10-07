import {
  controlMessageSchema,
  nativeVideoSignalEnvelopeSchema,
  peerSignalSchema,
  type ControlMessage,
  type NativeVideoSignalEnvelope,
  type PeerSignal,
} from '@ediz-remote/protocol'

export type ConnectionPath = 'direct' | 'relay' | 'unknown'
export type DataChannelKind = 'reliable' | 'pointer'
export type DataChannelRole = 'host' | 'guest'

export type { NativeVideoSignalEnvelope, PeerSignal }

export interface SessionDisplay {
  id: string
  label: string
  width: number
  height: number
}

export type QualityProfile = 'auto' | 'speed' | 'quality'
export type MediaState = 'starting' | 'sharing' | 'failed' | 'stopped'

const utf8Encoder = new TextEncoder()

interface SessionMessageEnvelope {
  channel: 'session'
  version: 2
  sequence: number
}

export type SessionDisplayMessage = SessionMessageEnvelope &
  (
    | {
      type: 'display.list'
      displays: SessionDisplay[]
      selectedDisplayId: string | null
    }
    | {
      type: 'display.select'
      displayId: string
    }
  )

export type SessionQualityMessage = SessionMessageEnvelope &
  (
    | {
      type: 'quality.state'
      profile: QualityProfile
    }
    | {
      type: 'quality.select'
      profile: QualityProfile
    }
  )

export interface RemoteCursorState {
  sequence: number
  x: number
  y: number
  visible: boolean
}

export type SessionCursorMessage = RemoteCursorState & SessionMessageEnvelope & {
  type: 'cursor.state'
}

export interface SessionMediaMessage extends SessionMessageEnvelope {
  type: 'media.state'
  state: MediaState
}

export interface SessionScreenShareMessage extends SessionMessageEnvelope {
  type: 'screen-share-state'
  active: boolean
}

export type SessionDataChannelMessage =
  | SessionDisplayMessage
  | SessionQualityMessage
  | SessionCursorMessage
  | SessionMediaMessage
  | SessionScreenShareMessage

export type DataChannelMessage =
  | { type: 'ping'; id: string; sentAt: number }
  | { type: 'pong'; id: string; sentAt: number }
  | SessionDataChannelMessage
  | ControlMessage

export function parsePeerSignal(value: unknown): PeerSignal | null {
  const result = peerSignalSchema.safeParse(value)
  return result.success ? result.data : null
}

export function parseNativeVideoSignalEnvelope(
  value: unknown,
): NativeVideoSignalEnvelope | null {
  const result = nativeVideoSignalEnvelopeSchema.safeParse(value)
  return result.success ? result.data : null
}

export function parseDataChannelMessage(value: string): DataChannelMessage | null {
  if (utf8Encoder.encode(value).byteLength > 4_096) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return null
    if (
      (parsed.type === 'ping' || parsed.type === 'pong') &&
      hasExactlyKeys(parsed, ['type', 'id', 'sentAt']) &&
      typeof parsed.id === 'string' &&
      parsed.id.length > 0 &&
      parsed.id.length <= 64 &&
      typeof parsed.sentAt === 'number' &&
      Number.isSafeInteger(parsed.sentAt) &&
      parsed.sentAt >= 0
    ) {
      return { type: parsed.type, id: parsed.id, sentAt: parsed.sentAt }
    }
    const screenShareMessage = parseSessionScreenShareMessage(parsed)
    if (screenShareMessage) return screenShareMessage
    const displayMessage = parseSessionDisplayMessage(parsed)
    if (displayMessage) return displayMessage
    const qualityMessage = parseSessionQualityMessage(parsed)
    if (qualityMessage) return qualityMessage
    const cursorMessage = parseSessionCursorMessage(parsed)
    if (cursorMessage) return cursorMessage
    const mediaMessage = parseSessionMediaMessage(parsed)
    if (mediaMessage) return mediaMessage
    const controlMessage = controlMessageSchema.safeParse(parsed)
    if (controlMessage.success) return controlMessage.data
  } catch {
    return null
  }
  return null
}

export function isSessionDataChannelMessage(
  message: DataChannelMessage,
): message is SessionDataChannelMessage {
  return 'channel' in message && message.channel === 'session'
}

export function isInboundDataChannelMessageAllowed(
  message: DataChannelMessage,
  channelKind: DataChannelKind,
  role: DataChannelRole,
  controlAllowed: boolean,
): boolean {
  if (channelKind === 'pointer') {
    return (
      role === 'host' &&
      controlAllowed &&
      message.type === 'control.event' &&
      message.event.kind === 'pointer.move'
    )
  }

  if (message.type === 'ping' || message.type === 'pong') return true
  if (role === 'guest') {
    if (message.type === 'control.granted') return controlAllowed
    return (
      message.type === 'screen-share-state' ||
      message.type === 'control.revoked' ||
      message.type === 'display.list' ||
      message.type === 'quality.state' ||
      message.type === 'media.state' ||
      message.type === 'cursor.state'
    )
  }

  if (message.type === 'control.event') return controlAllowed
  return message.type === 'display.select' || message.type === 'quality.select'
}

export function hasExpectedDataChannelTransport(
  channel: Pick<
    RTCDataChannel,
    'ordered' | 'maxRetransmits' | 'maxPacketLifeTime'
  >,
  channelKind: DataChannelKind,
): boolean {
  if (channelKind === 'reliable') {
    return (
      channel.ordered &&
      channel.maxRetransmits === null &&
      channel.maxPacketLifeTime === null
    )
  }
  return (
    !channel.ordered &&
    channel.maxRetransmits === 0 &&
    channel.maxPacketLifeTime === null
  )
}

function parseSessionScreenShareMessage(
  value: Record<string, unknown>,
): SessionScreenShareMessage | null {
  if (
    !hasExactlyKeys(value, ['channel', 'version', 'type', 'sequence', 'active']) ||
    !hasValidSessionEnvelope(value) ||
    value.type !== 'screen-share-state' ||
    typeof value.active !== 'boolean'
  ) {
    return null
  }
  return {
    channel: 'session',
    version: 2,
    type: 'screen-share-state',
    sequence: value.sequence as number,
    active: value.active,
  }
}

function parseSessionMediaMessage(
  value: Record<string, unknown>,
): SessionMediaMessage | null {
  if (
    !hasExactlyKeys(value, ['channel', 'version', 'type', 'sequence', 'state']) ||
    !hasValidSessionEnvelope(value) ||
    value.type !== 'media.state' ||
    !isMediaState(value.state)
  ) {
    return null
  }
  return {
    channel: 'session',
    version: 2,
    type: 'media.state',
    sequence: value.sequence as number,
    state: value.state,
  }
}

function parseSessionCursorMessage(
  value: Record<string, unknown>,
): SessionCursorMessage | null {
  if (
    !hasExactlyKeys(value, [
      'channel',
      'version',
      'type',
      'sequence',
      'x',
      'y',
      'visible',
    ]) ||
    !hasValidSessionEnvelope(value) ||
    value.type !== 'cursor.state' ||
    !isNormalizedCoordinate(value.x) ||
    !isNormalizedCoordinate(value.y) ||
    typeof value.visible !== 'boolean'
  ) {
    return null
  }
  return {
    channel: 'session',
    version: 2,
    type: 'cursor.state',
    sequence: value.sequence as number,
    x: value.x,
    y: value.y,
    visible: value.visible,
  }
}

function parseSessionQualityMessage(
  value: Record<string, unknown>,
): SessionQualityMessage | null {
  if (
    !hasExactlyKeys(value, ['channel', 'version', 'type', 'sequence', 'profile']) ||
    !hasValidSessionEnvelope(value) ||
    (value.type !== 'quality.state' && value.type !== 'quality.select') ||
    !isQualityProfile(value.profile)
  ) {
    return null
  }
  return {
    channel: 'session',
    version: 2,
    sequence: value.sequence as number,
    type: value.type,
    profile: value.profile,
  }
}

function parseSessionDisplayMessage(
  value: Record<string, unknown>,
): SessionDisplayMessage | null {
  if (!hasValidSessionEnvelope(value)) return null
  if (value.type === 'display.select') {
    return hasExactlyKeys(value, ['channel', 'version', 'type', 'sequence', 'displayId']) &&
      isBoundedString(value.displayId, 128)
      ? {
          channel: 'session',
          version: 2,
          type: 'display.select',
          sequence: value.sequence as number,
          displayId: value.displayId,
        }
      : null
  }
  if (
    !hasExactlyKeys(value, [
      'channel',
      'version',
      'type',
      'sequence',
      'displays',
      'selectedDisplayId',
    ]) ||
    value.type !== 'display.list' ||
    !Array.isArray(value.displays) ||
    value.displays.length > 16 ||
    !(
      value.selectedDisplayId === null ||
      isBoundedString(value.selectedDisplayId, 128)
    )
  ) {
    return null
  }
  const displays: SessionDisplay[] = []
  for (const item of value.displays) {
    if (
      !isRecord(item) ||
      !hasExactlyKeys(item, ['id', 'label', 'width', 'height']) ||
      !isBoundedString(item.id, 128) ||
      !isBoundedString(item.label, 128) ||
      !Number.isInteger(item.width) ||
      !Number.isInteger(item.height) ||
      (item.width as number) < 1 ||
      (item.height as number) < 1 ||
      (item.width as number) > 16_384 ||
      (item.height as number) > 16_384
    ) {
      return null
    }
    displays.push({
      id: item.id,
      label: item.label,
      width: item.width as number,
      height: item.height as number,
    })
  }
  if (
    value.selectedDisplayId !== null &&
    !displays.some((display) => display.id === value.selectedDisplayId)
  ) {
    return null
  }
  return {
    channel: 'session',
    version: 2,
    type: 'display.list',
    sequence: value.sequence as number,
    displays,
    selectedDisplayId: value.selectedDisplayId,
  }
}

export function classifyCandidatePair(
  localType?: string,
  remoteType?: string,
): ConnectionPath {
  if (localType === 'relay' || remoteType === 'relay') return 'relay'
  if (localType && remoteType) return 'direct'
  return 'unknown'
}

export async function detectConnectionPath(
  peerConnection: RTCPeerConnection,
): Promise<ConnectionPath> {
  const stats = await peerConnection.getStats()
  let selectedPairId: string | undefined
  let nominatedPairId: string | undefined

  stats.forEach((report) => {
    if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
      selectedPairId = report.selectedCandidatePairId
    }
    if (
      report.type === 'candidate-pair' &&
      report.state === 'succeeded' &&
      report.nominated === true
    ) {
      nominatedPairId = report.id
    }
  })

  const pair = stats.get(selectedPairId ?? nominatedPairId ?? '')
  if (!pair) return 'unknown'
  const localCandidate = stats.get(pair.localCandidateId)
  const remoteCandidate = stats.get(pair.remoteCandidateId)
  return classifyCandidatePair(
    localCandidate?.candidateType,
    remoteCandidate?.candidateType,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function hasValidSessionEnvelope(value: Record<string, unknown>): boolean {
  return (
    value.channel === 'session' &&
    value.version === 2 &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 0
  )
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
}

function isNormalizedCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function isQualityProfile(value: unknown): value is QualityProfile {
  return value === 'auto' || value === 'speed' || value === 'quality'
}

function isMediaState(value: unknown): value is MediaState {
  return (
    value === 'starting' ||
    value === 'sharing' ||
    value === 'failed' ||
    value === 'stopped'
  )
}
