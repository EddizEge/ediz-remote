import { describe, expect, it } from 'vitest'
import {
  classifyCandidatePair,
  hasExpectedDataChannelTransport,
  isInboundDataChannelMessageAllowed,
  parseDataChannelMessage,
  parseNativeVideoSignalEnvelope,
  parsePeerSignal,
} from './peerProtocol'

const negotiationId = '11111111-1111-4111-8111-111111111111'

describe('WebRTC peer protocol', () => {
  it('classifies relay and direct candidate pairs', () => {
    expect(classifyCandidatePair('host', 'srflx')).toBe('direct')
    expect(classifyCandidatePair('relay', 'srflx')).toBe('relay')
    expect(classifyCandidatePair(undefined, 'host')).toBe('unknown')
  })

  it('accepts only supported SDP descriptions', () => {
    expect(
      parsePeerSignal({
        kind: 'session-description',
        negotiationId,
        description: { type: 'offer', sdp: 'v=0' },
      }),
    ).toEqual({
      kind: 'session-description',
      negotiationId,
      description: { type: 'offer', sdp: 'v=0' },
    })
    expect(
      parsePeerSignal({
        kind: 'session-description',
        negotiationId,
        description: { type: 'rollback', sdp: '' },
      }),
    ).toBeNull()
  })

  it('keeps native video signaling separate from the control peer', () => {
    const envelope = {
      channel: 'native-video',
      version: 2,
      signal: {
        kind: 'session-description',
        negotiationId,
        description: { type: 'offer', sdp: 'v=0\r\nm=video' },
      },
    }

    expect(parsePeerSignal(envelope)).toBeNull()
    expect(parseNativeVideoSignalEnvelope(envelope)).toEqual(envelope)
    expect(
      parseNativeVideoSignalEnvelope({
        channel: 'native-video',
        version: 2,
        signal: {
          kind: 'ice-candidate',
          negotiationId,
          candidate: { candidate: 42 },
        },
      }),
    ).toBeNull()
    expect(
      parseNativeVideoSignalEnvelope({
        channel: 'native-video',
        signal: envelope.signal,
      }),
    ).toBeNull()
  })

  it('parses ping messages and rejects malformed channel data', () => {
    expect(
      parseDataChannelMessage('{"type":"ping","id":"ping-1","sentAt":42}'),
    ).toEqual({ type: 'ping', id: 'ping-1', sentAt: 42 })
    expect(parseDataChannelMessage('{"type":"ping"}')).toBeNull()
    expect(parseDataChannelMessage('not-json')).toBeNull()
  })

  it('parses screen sharing state messages', () => {
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'screen-share-state',
      sequence: 0,
      active: true,
    }))).toEqual({
      channel: 'session',
      version: 2,
      type: 'screen-share-state',
      sequence: 0,
      active: true,
    })
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'screen-share-state',
      sequence: 0,
      active: 'yes',
    }))).toBeNull()
    expect(
      parseDataChannelMessage('{"type":"screen-share-state","active":true}'),
    ).toBeNull()
  })

  it('validates versioned monitor list and selection messages', () => {
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'display.list',
      sequence: 0,
      displays: [
        { id: 'display-1', label: 'Ekran 1', width: 1920, height: 1080 },
      ],
      selectedDisplayId: 'display-1',
    }))).toMatchObject({ type: 'display.list', selectedDisplayId: 'display-1' })
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'display.select',
      sequence: 1,
      displayId: 'display-1',
    }))).toMatchObject({ type: 'display.select', displayId: 'display-1' })
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 1,
      type: 'display.select',
      sequence: 2,
      displayId: 'display-1',
    }))).toBeNull()
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'display.list',
      sequence: 3,
      displays: [],
      selectedDisplayId: 'missing',
    }))).toBeNull()
  })

  it('validates versioned quality profile state and selection messages', () => {
    for (const [sequence, profile] of ['auto', 'speed', 'quality'].entries()) {
      expect(parseDataChannelMessage(JSON.stringify({
        channel: 'session',
        version: 2,
        type: 'quality.select',
        sequence,
        profile,
      }))).toMatchObject({ type: 'quality.select', profile })
    }
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 1,
      type: 'quality.select',
      sequence: 3,
      profile: 'quality',
    }))).toBeNull()
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'quality.state',
      sequence: 4,
      profile: 'unbounded',
    }))).toBeNull()
  })

  it('validates sequenced remote cursor state', () => {
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'cursor.state',
      sequence: 91,
      x: 0.33,
      y: 0.66,
      visible: true,
    }))).toMatchObject({ type: 'cursor.state', sequence: 91, visible: true })
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'cursor.state',
      sequence: 92,
      x: 1.01,
      y: 0.5,
      visible: true,
    }))).toBeNull()
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 1,
      type: 'cursor.state',
      sequence: 93,
      x: 0.5,
      y: 0.5,
      visible: false,
    }))).toBeNull()
  })

  it('accepts only versioned allowlisted media states', () => {
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'media.state',
      sequence: 7,
      state: 'failed',
    }))).toEqual({
      channel: 'session',
      version: 2,
      type: 'media.state',
      sequence: 7,
      state: 'failed',
    })
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'media.state',
      sequence: 8,
      state: 'driver=C:\\private token=secret',
    }))).toBeNull()
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'media.state',
      sequence: -1,
      state: 'sharing',
    }))).toBeNull()
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'media.state',
      state: 'sharing',
    }))).toBeNull()
  })

  it('accepts versioned control grants and rejects unsafe control events', () => {
    expect(
      parseDataChannelMessage(
        JSON.stringify({
          channel: 'control',
          version: 1,
          type: 'control.granted',
          capabilities: ['pointer', 'keyboard'],
        }),
      ),
    ).toEqual({
      channel: 'control',
      version: 1,
      type: 'control.granted',
      capabilities: ['pointer', 'keyboard'],
    })
    expect(
      parseDataChannelMessage(
        JSON.stringify({
          channel: 'control',
          version: 1,
          type: 'control.event',
          sequence: 1,
          event: { kind: 'pointer.move', x: 1.1, y: 0.5 },
        }),
      ),
    ).toBeNull()
    expect(
      parseDataChannelMessage(
        JSON.stringify({
          channel: 'control',
          version: 2,
          type: 'control.revoked',
          reason: 'host',
        }),
      ),
    ).toBeNull()
    expect(parseDataChannelMessage('x'.repeat(4_097))).toBeNull()
  })

  it('enforces the label, direction, role, and control-access matrix', () => {
    const pointerMove = parseDataChannelMessage(JSON.stringify({
      channel: 'control',
      version: 1,
      type: 'control.event',
      sequence: 1,
      event: { kind: 'pointer.move', x: 0.5, y: 0.5 },
    }))!
    const keyboard = parseDataChannelMessage(JSON.stringify({
      channel: 'control',
      version: 1,
      type: 'control.event',
      sequence: 1,
      event: {
        kind: 'keyboard.key',
        code: 'KeyA',
        key: 'a',
        location: 0,
        down: true,
        repeat: false,
      },
    }))!
    const mediaState = parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'media.state',
      sequence: 1,
      state: 'sharing',
    }))!

    expect(isInboundDataChannelMessageAllowed(pointerMove, 'pointer', 'host', true)).toBe(true)
    expect(isInboundDataChannelMessageAllowed(pointerMove, 'reliable', 'host', true)).toBe(true)
    expect(isInboundDataChannelMessageAllowed(pointerMove, 'pointer', 'host', false)).toBe(false)
    expect(isInboundDataChannelMessageAllowed(pointerMove, 'pointer', 'guest', true)).toBe(false)
    expect(isInboundDataChannelMessageAllowed(keyboard, 'pointer', 'host', true)).toBe(false)
    expect(isInboundDataChannelMessageAllowed(mediaState, 'pointer', 'guest', true)).toBe(false)
    expect(isInboundDataChannelMessageAllowed(mediaState, 'reliable', 'guest', false)).toBe(true)
    expect(isInboundDataChannelMessageAllowed(mediaState, 'reliable', 'host', true)).toBe(false)
    expect(isInboundDataChannelMessageAllowed(keyboard, 'reliable', 'host', true)).toBe(true)

    const ping = parseDataChannelMessage('{"type":"ping","id":"ping-1","sentAt":1}')!
    const screenState = parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'screen-share-state',
      sequence: 2,
      active: true,
    }))!
    expect(isInboundDataChannelMessageAllowed(ping, 'pointer', 'host', true)).toBe(false)
    expect(isInboundDataChannelMessageAllowed(screenState, 'reliable', 'guest', false)).toBe(true)
    expect(isInboundDataChannelMessageAllowed(screenState, 'reliable', 'host', true)).toBe(false)
  })

  it('requires canonical reliability settings for both labels', () => {
    expect(hasExpectedDataChannelTransport({
      ordered: true,
      maxRetransmits: null,
      maxPacketLifeTime: null,
    }, 'reliable')).toBe(true)
    expect(hasExpectedDataChannelTransport({
      ordered: false,
      maxRetransmits: 0,
      maxPacketLifeTime: null,
    }, 'pointer')).toBe(true)
    expect(hasExpectedDataChannelTransport({
      ordered: true,
      maxRetransmits: 0,
      maxPacketLifeTime: null,
    }, 'pointer')).toBe(false)
  })

  it('uses UTF-8 byte bounds and rejects extra session fields', () => {
    expect(parseDataChannelMessage(`{"type":"ping","id":"${'💣'.repeat(1_100)}","sentAt":1}`)).toBeNull()
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'quality.select',
      sequence: 0,
      profile: 'auto',
      privileged: true,
    }))).toBeNull()
  })

  it('requires exact keys on every session v2 message shape', () => {
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'screen-share-state',
      sequence: 0,
      active: true,
      debug: true,
    }))).toBeNull()
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'display.list',
      sequence: 1,
      displays: [
        { id: 'display-1', label: 'Ekran 1', width: 1920, height: 1080, dpi: 96 },
      ],
      selectedDisplayId: 'display-1',
    }))).toBeNull()
    expect(parseDataChannelMessage(JSON.stringify({
      channel: 'session',
      version: 2,
      type: 'media.state',
      sequence: 2,
      state: 'sharing',
      detail: 'secret',
    }))).toBeNull()
  })
})
