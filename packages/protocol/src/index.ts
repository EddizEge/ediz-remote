import { z } from 'zod'

export const SIGNALING_PROTOCOL_VERSION = 3 as const
export const MINIMUM_SIGNALING_PROTOCOL_VERSION = 3 as const
export const SIGNALING_SUBPROTOCOL =
  `ediz-remote.v${SIGNALING_PROTOCOL_VERSION}` as const
export const MAX_SIGNALING_MESSAGE_BYTES = 128 * 1024

export const sessionCodeSchema = z.string().regex(/^\d{6}$/)
export const controlAccessModeSchema = z.enum(['view', 'control'])
export type ControlAccessMode = z.infer<typeof controlAccessModeSchema>

const iceUrlSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?:stun|stuns|turn|turns):/i)

export const iceServerSchema = z
  .strictObject({
    urls: z.array(iceUrlSchema).min(1).max(4),
    username: z.string().min(1).max(512).optional(),
    credential: z.string().min(1).max(512).optional(),
  })
  .refine(
    (server) =>
      (server.username === undefined) === (server.credential === undefined),
    'ICE kullanıcı adı ve parolası birlikte verilmelidir.',
  )

export const iceConfigurationSchema = z.strictObject({
  version: z.literal(1),
  expiresAt: z.string().datetime().nullable(),
  iceServers: z.array(iceServerSchema).min(1).max(8),
})
export type IceServer = z.infer<typeof iceServerSchema>
export type IceConfiguration = z.infer<typeof iceConfigurationSchema>

export const resumeTokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)

const controlCapabilitySchema = z.enum(['pointer', 'keyboard'])
const controlEnvelopeSchema = z.strictObject({
  channel: z.literal('control'),
  version: z.literal(1),
})

const controlRequestSchema = controlEnvelopeSchema.extend({
  type: z.literal('control.request'),
  capabilities: z.array(controlCapabilitySchema).min(1).max(2),
})

const controlGrantedSchema = controlEnvelopeSchema.extend({
  type: z.literal('control.granted'),
  capabilities: z.array(controlCapabilitySchema).min(1).max(2),
})

const controlRevokedSchema = controlEnvelopeSchema.extend({
  type: z.literal('control.revoked'),
  reason: z.enum(['host', 'session-ended']),
})

const pointerMoveSchema = z.strictObject({
  kind: z.literal('pointer.move'),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
})

const pointerButtonSchema = z.strictObject({
  kind: z.literal('pointer.button'),
  button: z.enum(['left', 'middle', 'right']),
  down: z.boolean(),
  x: z.number().finite().min(0).max(1).optional(),
  y: z.number().finite().min(0).max(1).optional(),
})

const pointerWheelSchema = z.strictObject({
  kind: z.literal('pointer.wheel'),
  deltaX: z.number().finite().min(-10_000).max(10_000),
  deltaY: z.number().finite().min(-10_000).max(10_000),
})

const keyboardKeySchema = z.strictObject({
  kind: z.literal('keyboard.key'),
  code: z.string().min(1).max(64),
  key: z.string().min(1).max(64),
  location: z.number().int().min(0).max(3),
  down: z.boolean(),
  repeat: z.boolean(),
})

const controlEventSchema = controlEnvelopeSchema.extend({
  type: z.literal('control.event'),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  event: z.discriminatedUnion('kind', [
    pointerMoveSchema,
    pointerButtonSchema,
    pointerWheelSchema,
    keyboardKeySchema,
  ]),
})

const controlMessageUnionSchema = z.discriminatedUnion('type', [
  controlRequestSchema,
  controlGrantedSchema,
  controlRevokedSchema,
  controlEventSchema,
])
export const controlMessageSchema = z.preprocess(
  rejectPrototypeRootKey,
  controlMessageUnionSchema,
)
export type ControlMessage = z.infer<typeof controlMessageSchema>
export type ControlInputEvent = Extract<
  ControlMessage,
  { type: 'control.event' }
>['event']

const createSessionSchema = z.strictObject({
  type: z.literal('create_session'),
})

const joinSessionSchema = z.strictObject({
  type: z.literal('join_session'),
  code: sessionCodeSchema,
})

const requestDecisionSchema = z.strictObject({
  type: z.literal('request_decision'),
  requestId: z.string().uuid(),
  approved: z.boolean(),
  accessMode: controlAccessModeSchema.optional(),
}).refine(
  (message) =>
    message.approved
      ? message.accessMode !== undefined
      : message.accessMode === undefined,
  {
    message: 'Erişim modu yalnızca onaylanan istek için verilmelidir.',
    path: ['accessMode'],
  },
)

const textEncoder = new TextEncoder()

function hasOnlySafeSdpCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (
      codeUnit <= 0x08 ||
      codeUnit === 0x0b ||
      codeUnit === 0x0c ||
      (codeUnit >= 0x0e && codeUnit <= 0x1f) ||
      codeUnit === 0x7f
    ) return false
  }
  return true
}

export const negotiationIdSchema = z.string().uuid()

const sessionDescriptionSchema = z.strictObject({
  type: z.enum(['offer', 'answer']),
  sdp: z
    .string()
    .min(1)
    .refine(
      hasOnlySafeSdpCharacters,
      'SDP yalnız güvenli metin ve CR/LF/TAB ayırıcıları içerebilir.',
    )
    .refine(
      (value) => textEncoder.encode(value).byteLength <= 60 * 1024,
      'SDP UTF-8 boyutu 60 KiB sınırını aşamaz.',
    ),
})

const iceCandidateSchema = z.strictObject({
  candidate: z.string().max(4_096),
  sdpMid: z.string().max(256).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(65_535).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
})

export const peerSignalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session-description'),
    negotiationId: negotiationIdSchema,
    description: sessionDescriptionSchema,
  }),
  z.strictObject({
    kind: z.literal('ice-candidate'),
    negotiationId: negotiationIdSchema,
    candidate: iceCandidateSchema,
  }),
])
export type PeerSignal = z.infer<typeof peerSignalSchema>

export const nativeVideoSignalEnvelopeSchema = z.strictObject({
  channel: z.literal('native-video'),
  version: z.literal(2),
  signal: peerSignalSchema,
})
export type NativeVideoSignalEnvelope = z.infer<
  typeof nativeVideoSignalEnvelopeSchema
>

export const signalingPayloadSchema = z.union([
  peerSignalSchema,
  nativeVideoSignalEnvelopeSchema,
])
export type SignalingPayload = z.infer<typeof signalingPayloadSchema>

const signalSchema = z.strictObject({
  type: z.literal('signal'),
  payload: signalingPayloadSchema,
})

const resumeSessionSchema = z.strictObject({
  type: z.literal('resume_session'),
  token: resumeTokenSchema,
})

const refreshIceSchema = z.strictObject({
  type: z.literal('refresh_ice'),
})

const revokeControlSchema = z.strictObject({
  type: z.literal('revoke_control'),
  channel: z.literal('control'),
  version: z.literal(1),
})

const leaveSessionSchema = z.strictObject({
  type: z.literal('leave_session'),
})

const pingSchema = z.strictObject({
  type: z.literal('ping'),
})

const clientMessageUnionSchema = z.discriminatedUnion('type', [
  createSessionSchema,
  joinSessionSchema,
  requestDecisionSchema,
  signalSchema,
  resumeSessionSchema,
  refreshIceSchema,
  revokeControlSchema,
  leaveSessionSchema,
  pingSchema,
])
export const clientMessageSchema = z.preprocess(
  rejectPrototypeRootKey,
  clientMessageUnionSchema,
)

export type ClientMessage = z.infer<typeof clientMessageSchema>

const participantIdSchema = z.string().uuid()
const requestIdSchema = z.string().uuid()
const reconnectGraceSecondsSchema = z.number().int().min(1).max(300)
const plainServerErrorCodeSchema = z.enum([
  'invalid_message',
  'invalid_code',
  'session_busy',
  'not_authorized',
  'invalid_resume',
  'peer_unavailable',
  'negotiation_exhausted',
])
const serverErrorOperationSchema = z.enum([
  'create_session',
  'join_session',
  'resume_session',
  'refresh_ice',
  'signal',
])
export type ServerErrorOperation = z.infer<typeof serverErrorOperationSchema>

const serverErrorMessageSchema = z.discriminatedUnion('code', [
  z.strictObject({
    type: z.literal('error'),
    code: z.literal('rate_limited'),
    message: z.string().min(1).max(512),
    operation: serverErrorOperationSchema,
    retryAfterSeconds: z.number().int().min(1).max(300),
  }),
  z.strictObject({
    type: z.literal('error'),
    code: z.literal('capacity_exceeded'),
    message: z.string().min(1).max(512),
    operation: z.literal('create_session'),
    retryAfterSeconds: z.number().int().min(1).max(300),
  }),
  z.strictObject({
    type: z.literal('error'),
    code: plainServerErrorCodeSchema,
    message: z.string().min(1).max(512),
  }),
])

const serverMessageUnionSchema = z.union([
  z.strictObject({
    type: z.literal('ready'),
    clientId: participantIdSchema,
    protocolVersion: z.literal(SIGNALING_PROTOCOL_VERSION),
    minimumProtocolVersion: z.literal(MINIMUM_SIGNALING_PROTOCOL_VERSION),
  }),
  z.strictObject({
    type: z.literal('session_created'),
    code: sessionCodeSchema,
    expiresAt: z.string().datetime(),
  }),
  z.strictObject({
    type: z.literal('join_pending'),
    code: sessionCodeSchema,
    requestId: requestIdSchema,
  }),
  z.strictObject({
    type: z.literal('incoming_request'),
    requestId: requestIdSchema,
  }),
  z.strictObject({
    type: z.literal('session_approved'),
    code: sessionCodeSchema,
    peerId: participantIdSchema,
    accessMode: controlAccessModeSchema,
    iceConfiguration: iceConfigurationSchema,
    resumeToken: resumeTokenSchema,
    reconnectGraceSeconds: reconnectGraceSecondsSchema,
  }),
  z.strictObject({
    type: z.literal('peer_joined'),
    peerId: participantIdSchema,
    accessMode: controlAccessModeSchema,
    iceConfiguration: iceConfigurationSchema,
    resumeToken: resumeTokenSchema,
    reconnectGraceSeconds: reconnectGraceSecondsSchema,
  }),
  z.strictObject({
    type: z.literal('session_resumed'),
    role: z.enum(['host', 'guest']),
    code: sessionCodeSchema,
    peerId: z.union([participantIdSchema, z.literal('')]),
    accessMode: controlAccessModeSchema,
    resumeToken: resumeTokenSchema,
    peerConnected: z.boolean(),
    reconnectGraceSeconds: reconnectGraceSecondsSchema,
    iceConfiguration: iceConfigurationSchema,
  }),
  z.strictObject({
    type: z.literal('peer_suspended'),
    reconnectUntil: z.string().datetime(),
  }),
  z.strictObject({
    type: z.literal('peer_resumed'),
    peerId: participantIdSchema,
    iceConfiguration: iceConfigurationSchema,
  }),
  z.strictObject({
    type: z.literal('ice_configuration'),
    iceConfiguration: iceConfigurationSchema,
  }),
  z.strictObject({ type: z.literal('request_rejected') }),
  z.strictObject({ type: z.literal('peer_left') }),
  z.strictObject({
    type: z.literal('session_ended'),
    reason: z.enum(['host_left', 'expired', 'replaced', 'reconnect_timeout']),
  }),
  z.strictObject({
    type: z.literal('signal'),
    from: participantIdSchema,
    payload: signalingPayloadSchema,
  }),
  z.strictObject({ type: z.literal('pong') }),
  serverErrorMessageSchema,
])
export const serverMessageSchema = z.preprocess(
  rejectPrototypeRootKey,
  serverMessageUnionSchema,
)

export type ServerMessage = z.infer<typeof serverMessageSchema>

function rejectPrototypeRootKey(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, '__proto__')
  ) {
    return undefined
  }
  return value
}
