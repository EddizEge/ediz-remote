import { describe, expect, it } from 'vitest'
import {
  hasTurnServer,
  resolveIceServers,
  resolveIceTransportPolicy,
} from './iceConfiguration'

describe('ICE configuration', () => {
  it('passes server-issued TURN credentials to RTCPeerConnection', () => {
    const configuration = {
      version: 1 as const,
      expiresAt: '2026-07-23T12:10:00.000Z',
      iceServers: [
        { urls: ['stun:stun.example.test:3478'] },
        {
          urls: ['turn:turn.example.test:3478?transport=udp'],
          username: '123:client',
          credential: 'credential',
        },
      ],
    }

    expect(resolveIceServers(configuration)).toEqual(configuration.iceServers)
    expect(hasTurnServer(configuration)).toBe(true)
  })

  it('keeps a STUN fallback for older signaling servers', () => {
    expect(resolveIceServers(null)[0]?.urls).toContain(
      'stun:stun.cloudflare.com:3478',
    )
    expect(hasTurnServer(null)).toBe(false)
  })

  it('uses the safe default ICE transport policy', () => {
    expect(resolveIceTransportPolicy()).toBe('all')
  })
})
