import { describe, expect, it } from 'vitest'
import { serverMessageSchema } from '@ediz-remote/protocol'

describe('server message boundary', () => {
  it('accepts a bounded ready message', () => {
    expect(serverMessageSchema.safeParse({
      type: 'ready',
      clientId: '19f3d8f5-2af5-4e77-a155-41e60d94c1b2',
      protocolVersion: 3,
      minimumProtocolVersion: 3,
    }).success).toBe(true)
  })

  it('rejects a downgraded or ambiguous ready message', () => {
    expect(serverMessageSchema.safeParse({
      type: 'ready',
      clientId: '19f3d8f5-2af5-4e77-a155-41e60d94c1b2',
      protocolVersion: 1,
      minimumProtocolVersion: 1,
    }).success).toBe(false)
    expect(serverMessageSchema.safeParse({
      type: 'ready',
      clientId: '19f3d8f5-2af5-4e77-a155-41e60d94c1b2',
      protocolVersion: 3,
      minimumProtocolVersion: 3,
      ignoredVersion: 3,
    }).success).toBe(false)
  })

  it('rejects malformed session data before it reaches React', () => {
    expect(serverMessageSchema.safeParse({
      type: 'session_created',
      code: { unsafe: true },
      expiresAt: 'not-a-date',
    }).success).toBe(false)
  })

  it('bounds diagnostic text received from the service', () => {
    expect(serverMessageSchema.safeParse({
      type: 'error',
      code: 'invalid_code',
      message: 'x'.repeat(513),
    }).success).toBe(false)
  })

  it('rejects ambiguous retry metadata at the React boundary', () => {
    expect(serverMessageSchema.safeParse({
      type: 'error',
      code: 'rate_limited',
      message: 'Wait',
    }).success).toBe(false)
    expect(serverMessageSchema.safeParse({
      type: 'error',
      code: 'invalid_code',
      message: 'Invalid',
      operation: 'join_session',
      retryAfterSeconds: 5,
    }).success).toBe(false)
  })
})
