import { createSecretKey } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  MAX_SIGNALING_MESSAGE_BYTES,
  MINIMUM_SIGNALING_PROTOCOL_VERSION,
  SIGNALING_PROTOCOL_VERSION,
  SIGNALING_SUBPROTOCOL,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type SignalingPayload,
} from '@ediz-remote/protocol'
import {
  createSignalingServer,
  type SecurityAuditRecorder,
  type SignalingServer,
  type SignalingServerOptions,
} from '../src/server.js'
import {
  SecurityAuditWriter,
  type CoarseClientBucket,
  type SecurityAuditEnqueueResult,
  type SecurityAuditEventInput,
  type SecurityAuditFlushResult,
} from '../src/securityAudit.js'

const runningServers: SignalingServer[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()))
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('signaling server', () => {
  it('serves fixed browser security headers without framework disclosure', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
    })
    runningServers.push(server)
    const port = await server.start()

    const response = await fetch(`http://127.0.0.1:${port}/health`)
    const policy = response.headers.get('content-security-policy') ?? ''
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("script-src-attr 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(response.headers.get('permissions-policy')).toContain(
      'display-capture=(self)',
    )
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('x-powered-by')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects rate-limit TTL values that would erase token debt early', () => {
    expect(() =>
      createSignalingServer({
        staticDir: null,
        security: {
          ipBucketIdleTtlMs: 1_000,
          createSession: { capacity: 4, refillPerSecond: 0.01 },
        },
      }),
    ).toThrow(/oran borcu TTL ile sıfırlanır/)
  })

  it('fails closed before listening when security audit initialization fails', async () => {
    const failed: SecurityAuditFlushResult = {
      ok: false,
      errorCode: 'audit_write_failed',
      droppedEntries: 0,
    }
    let closeCalls = 0
    const audit: SecurityAuditRecorder = {
      status: { ok: false },
      initialize: async () => failed,
      bucketClientIp: () => null,
      record: () => ({ accepted: true }),
      close: async () => {
        closeCalls += 1
        return failed
      },
    }
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      audit,
    })

    await expect(server.start()).rejects.toThrow(
      'Güvenlik audit katmanı başlatılamadı.',
    )
    expect(server.httpServer.listening).toBe(false)
    await expect(Promise.all([server.stop(), server.stop()])).resolves.toEqual([
      undefined,
      undefined,
    ])
    expect(closeCalls).toBe(1)
  })

  it('does not listen when initialized audit health is already unavailable', async () => {
    const audit = new ControllableSecurityAuditRecorder()
    audit.healthy = false
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      audit,
    })

    await expect(server.start()).rejects.toThrow(
      'Güvenlik audit katmanı başlatılamadı.',
    )
    expect(server.httpServer.listening).toBe(false)
    await expect(server.stop()).resolves.toBeUndefined()
  })

  it('returns only a fixed unavailable health status when audit degrades', async () => {
    const audit = new ControllableSecurityAuditRecorder()
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      audit,
    })
    runningServers.push(server)
    const port = await server.start()
    audit.healthy = false

    const response = await fetch(`http://127.0.0.1:${port}/health`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'unavailable' })
    await expect(
      rejectedUpgradeStatus(
        `ws://127.0.0.1:${port}/ws`,
        SIGNALING_SUBPROTOCOL,
        `http://127.0.0.1:${port}`,
      ),
    ).resolves.toBe(503)
  })

  it('terminates existing inbound traffic after runtime audit degradation', async () => {
    const audit = new ControllableSecurityAuditRecorder()
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      audit,
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`
    const client = await connect(url)

    audit.healthy = false
    const closed = waitForSocketClose(client.socket)
    send(client.socket, { type: 'ping' })
    await closed

    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).toBe(503)
    expect(await health.json()).toEqual({ status: 'unavailable' })
    await expect(
      rejectedUpgradeStatus(
        url,
        SIGNALING_SUBPROTOCOL,
        webSocketOrigin(url),
      ),
    ).resolves.toBe(503)
  })

  it('does not grant access when the critical approval audit cannot enqueue', async () => {
    const audit = new ControllableSecurityAuditRecorder()
    audit.failEventType = 'approval_granted'
    const { host, guest, url } = await connectPair({ audit })
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    const hostClosed = waitForSocketClose(host.socket)
    const guestClosed = waitForSocketClose(guest.socket)

    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'control',
    })
    await Promise.all([hostClosed, guestClosed])

    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'approval_granted',
          outcome: 'allowed',
          role: 'host',
          reasonCode: 'host_decision',
        }),
      ]),
    )
    const health = await fetch(
      url.replace(/^ws:/, 'http:').replace('/ws', '/health'),
    )
    expect(health.status).toBe(503)
    await expect(
      rejectedUpgradeStatus(url, SIGNALING_SUBPROTOCOL, webSocketOrigin(url)),
    ).resolves.toBe(503)
  })

  it('does not mutate a session when resume success auditing fails', async () => {
    const audit = new ControllableSecurityAuditRecorder()
    const pair = await connectApprovedPair({ audit })
    await closeSocket(pair.guest.socket)
    await pair.host.next('peer_suspended')
    audit.failEventType = 'resume_succeeded'

    const resumedGuest = await connect(pair.url)
    const resumedClosed = waitForSocketClose(resumedGuest.socket)
    send(resumedGuest.socket, {
      type: 'resume_session',
      token: pair.approved.resumeToken,
    })
    await resumedClosed

    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'resume_succeeded',
          outcome: 'allowed',
          role: 'guest',
          reasonCode: 'grace_recovery',
        }),
      ]),
    )
    const health = await fetch(
      pair.url.replace(/^ws:/, 'http:').replace('/ws', '/health'),
    )
    expect(health.status).toBe(503)
    const hostClosed = waitForSocketClose(pair.host.socket)
    send(pair.host.socket, { type: 'ping' })
    await hostClosed
  })

  it('does not create a replacement session after end auditing fails', async () => {
    const audit = new ControllableSecurityAuditRecorder()
    const pair = await connectApprovedPair({ audit })
    audit.failEventType = 'session_ended'
    const receivedTypes: string[] = []
    pair.host.socket.on('message', (data) => {
      const parsed = serverMessageSchema.safeParse(JSON.parse(data.toString()))
      if (parsed.success) receivedTypes.push(parsed.data.type)
    })
    const hostClosed = waitForSocketClose(pair.host.socket)

    send(pair.host.socket, { type: 'create_session' })
    await hostClosed

    expect(receivedTypes).not.toContain('session_created')
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'session_ended',
          outcome: 'ended',
          role: 'system',
          reasonCode: 'replaced',
        }),
      ]),
    )
    const health = await fetch(
      pair.url.replace(/^ws:/, 'http:').replace('/ws', '/health'),
    )
    expect(health.status).toBe(503)
  })

  it('reports health without exposing ICE credentials', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      ice: {
        stunUrls: ['stun:stun.example.test:3478'],
        turnUrls: ['turn:turn.example.test:3478'],
        turnSharedSecret: 'must-not-appear',
        turnCredentialTtlSeconds: 600,
      },
    })
    runningServers.push(server)
    const port = await server.start()

    const response = await fetch(`http://127.0.0.1:${port}/health`)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(JSON.parse(body)).toEqual({ status: 'ok', sessions: 0 })
    expect(body).not.toContain('must-not-appear')
  })

  it('audits security decisions without recording signaling secrets or identifiers', async () => {
    const directory = await temporaryDirectory()
    const auditWriter = new SecurityAuditWriter({
      directory,
      ipBucketKey: createSecretKey(Buffer.alloc(32, 0x31)),
      buildId: 'ediz-remote@integration-test',
      protocolVersion: SIGNALING_PROTOCOL_VERSION,
      retentionDays: 2,
      now: () => new Date('2026-09-03T12:00:00.000Z'),
    })
    const audit = new CapturingSecurityAuditRecorder(auditWriter)
    const turnSecret = 'TURN_SENTINEL_SECRET_DO_NOT_AUDIT'
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      now: () => Date.parse('2026-09-03T12:00:00.000Z'),
      trustCloudflareConnectingIp: true,
      audit,
      ice: {
        stunUrls: [],
        turnUrls: ['turn:turn-sentinel.example.test:3478'],
        turnSharedSecret: turnSecret,
        turnCredentialTtlSeconds: 600,
      },
      security: {
        joinSession: { capacity: 1, refillPerSecond: 1 / 60 },
      },
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`
    const rawIps = [
      '203.0.113.77',
      '203.0.113.10',
      '203.0.113.11',
      '203.0.113.12',
      '203.0.113.13',
      '203.0.113.14',
    ]

    await expect(
      rejectedUpgradeStatus(
        url,
        'ediz-remote.v2',
        webSocketOrigin(url),
        { 'CF-Connecting-IP': rawIps[0]! },
      ),
    ).resolves.toBe(426)
    await expect(
      rejectedUpgradeStatus(url, SIGNALING_SUBPROTOCOL, 'https://evil.test', {
        'CF-Connecting-IP': rawIps[0]!,
      }),
    ).resolves.toBe(403)

    const invalidCode = '654321'
    const rejectedGuest = await connect(url, {
      headers: { 'CF-Connecting-IP': rawIps[0]! },
    })
    send(rejectedGuest.socket, { type: 'join_session', code: invalidCode })
    expect((await rejectedGuest.next('error')).code).toBe('invalid_code')
    send(rejectedGuest.socket, { type: 'join_session', code: invalidCode })
    expect(await rejectedGuest.next('error')).toMatchObject({
      code: 'rate_limited',
      operation: 'join_session',
    })
    await closeSocket(rejectedGuest.socket)

    const [host, guest] = await Promise.all([
      connect(url, { headers: { 'CF-Connecting-IP': rawIps[1]! } }),
      connect(url, { headers: { 'CF-Connecting-IP': rawIps[2]! } }),
    ])
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'control',
    })
    const [approved, joined] = await Promise.all([
      guest.next('session_approved'),
      host.next('peer_joined'),
    ])

    const negotiationId = 'abababab-abab-4bab-8bab-abababababab'
    const sentinelSdp = 'v=0\r\na=x-audit-sentinel-sdp'
    const sentinelCandidate = 'candidate:audit-sentinel-ice'
    const offer = descriptionSignal('offer', sentinelSdp, negotiationId)
    send(host.socket, { type: 'signal', payload: offer })
    expect((await guest.next('signal')).payload).toEqual(offer)
    const candidate = candidateSignal(sentinelCandidate, negotiationId)
    send(host.socket, { type: 'signal', payload: candidate })
    expect((await guest.next('signal')).payload).toEqual(candidate)

    send(host.socket, {
      type: 'revoke_control',
      channel: 'control',
      version: 1,
    })
    send(host.socket, {
      type: 'revoke_control',
      channel: 'control',
      version: 1,
    })

    const invalidResumeToken = 'A'.repeat(43)
    const invalidResumeClient = await connect(url, {
      headers: { 'CF-Connecting-IP': rawIps[4]! },
    })
    send(invalidResumeClient.socket, {
      type: 'resume_session',
      token: invalidResumeToken,
    })
    expect((await invalidResumeClient.next('error')).code).toBe(
      'invalid_resume',
    )
    await closeSocket(invalidResumeClient.socket)

    await closeSocket(guest.socket)
    await host.next('peer_suspended')
    const resumedGuest = await connect(url, {
      headers: { 'CF-Connecting-IP': rawIps[2]! },
    })
    send(resumedGuest.socket, {
      type: 'resume_session',
      token: approved.resumeToken,
    })
    const [resumed] = await Promise.all([
      resumedGuest.next('session_resumed'),
      host.next('peer_resumed'),
    ])

    send(resumedGuest.socket, { type: 'leave_session' })
    await host.next('peer_left')

    send(host.socket, { type: 'create_session' })
    const secondCreated = await host.next('session_created')
    const deniedGuest = await connect(url, {
      headers: { 'CF-Connecting-IP': rawIps[3]! },
    })
    send(deniedGuest.socket, {
      type: 'join_session',
      code: secondCreated.code,
    })
    const deniedRequest = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: deniedRequest.requestId,
      approved: false,
    })
    await deniedGuest.next('request_rejected')

    const secondHost = await connect(url, {
      headers: { 'CF-Connecting-IP': rawIps[5]! },
    })
    send(secondHost.socket, { type: 'create_session' })
    const thirdCreated = await secondHost.next('session_created')

    await Promise.all([server.stop(), server.stop()])

    const eventTuples = audit.events.map(
      ({ eventType, outcome, role, reasonCode }) =>
        `${eventType}/${outcome}/${role}/${reasonCode}`,
    )
    expect(eventTuples).toEqual(
      expect.arrayContaining([
        'upgrade_rejected/rejected/unknown/unsupported_protocol',
        'upgrade_rejected/rejected/unknown/invalid_origin',
        'join_rejected/rejected/unknown/invalid_or_expired',
        'join_rate_limited/rate_limited/unknown/rate_limited',
        'approval_granted/allowed/host/host_decision',
        'resume_rejected/rejected/unknown/invalid_resume',
        'resume_succeeded/allowed/guest/grace_recovery',
        'control_revoked/allowed/host/host_request',
        'session_ended/ended/guest/guest_left',
        'approval_rejected/rejected/host/host_decision',
        'session_ended/ended/system/server_shutdown',
      ]),
    )
    expect(
      audit.events.filter((event) => event.eventType === 'control_revoked'),
    ).toHaveLength(1)
    expect(
      audit.events.filter(
        (event) =>
          event.eventType === 'session_ended' &&
          event.reasonCode === 'server_shutdown',
      ),
    ).toHaveLength(2)

    const files = await readdirAuditFiles(directory)
    const persistedAudit = (
      await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
    ).join('\n')
    const recorderInput = JSON.stringify(audit.events)
    const turnServers = [
      ...approved.iceConfiguration.iceServers,
      ...joined.iceConfiguration.iceServers,
    ]
    const prohibitedValues = [
      ...rawIps,
      invalidCode,
      created.code,
      secondCreated.code,
      thirdCreated.code,
      incoming.requestId,
      deniedRequest.requestId,
      host.clientId,
      guest.clientId,
      secondHost.clientId,
      approved.resumeToken,
      joined.resumeToken,
      resumed.resumeToken,
      invalidResumeToken,
      negotiationId,
      sentinelSdp,
      sentinelCandidate,
      turnSecret,
      ...turnServers.flatMap((iceServer) => [
        ...(Array.isArray(iceServer.urls) ? iceServer.urls : [iceServer.urls]),
        iceServer.username ?? '',
        iceServer.credential ?? '',
      ]),
    ].filter((value) => value.length > 0)
    for (const prohibitedValue of prohibitedValues) {
      expect(recorderInput).not.toContain(prohibitedValue)
      expect(persistedAudit).not.toContain(prohibitedValue)
    }
  })

  it('requires the supported subprotocol and an allowed browser origin', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`

    await expect(
      rejectedUpgradeStatus(url, undefined, webSocketOrigin(url)),
    ).resolves.toBe(426)
    await expect(
      rejectedUpgradeStatus(url, 'ediz-remote.v1', webSocketOrigin(url)),
    ).resolves.toBe(426)
    await expect(
      rejectedUpgradeStatus(url, 'ediz-remote.v2', webSocketOrigin(url)),
    ).resolves.toBe(426)
    await expect(
      rejectedUpgradeStatus(url, SIGNALING_SUBPROTOCOL, 'https://evil.example'),
    ).resolves.toBe(403)
    await expect(
      rejectedUpgradeStatus(url, SIGNALING_SUBPROTOCOL, undefined),
    ).resolves.toBe(403)

    const desktop = await connect(url, {
      origin: 'https://app.ediz-remote.local',
    })
    expect(desktop.socket.protocol).toBe(SIGNALING_SUBPROTOCOL)
    desktop.socket.close()
  })

  it('ignores spoofed Cloudflare client IP headers unless explicitly trusted', async () => {
    const untrustedServer = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
    })
    runningServers.push(untrustedServer)
    const untrustedPort = await untrustedServer.start()
    const untrustedUrl = `ws://127.0.0.1:${untrustedPort}/ws`

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const client = await connect(untrustedUrl, {
        headers: { 'CF-Connecting-IP': `198.51.100.${attempt + 1}` },
      })
      send(client.socket, { type: 'join_session', code: '999999' })
      const error = await client.next('error')
      expect(error.code).toBe(attempt < 8 ? 'invalid_code' : 'rate_limited')
      client.socket.close()
    }

    const trustedServer = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      trustCloudflareConnectingIp: true,
    })
    runningServers.push(trustedServer)
    const trustedPort = await trustedServer.start()
    const trustedUrl = `ws://127.0.0.1:${trustedPort}/ws`

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const client = await connect(trustedUrl, {
        headers: { 'CF-Connecting-IP': `203.0.113.${attempt + 1}` },
      })
      send(client.socket, { type: 'join_session', code: '999999' })
      expect((await client.next('error')).code).toBe('invalid_code')
      client.socket.close()
    }
  })

  it('rejects binary, unknown, and extra-field messages without stopping the socket', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
    })
    runningServers.push(server)
    const port = await server.start()
    const client = await connect(`ws://127.0.0.1:${port}/ws`)

    client.socket.send(JSON.stringify({ type: 'create_session', elevated: true }))
    expect((await client.next('error')).code).toBe('invalid_message')

    client.socket.send(JSON.stringify({
      type: 'signal',
      payload: {
        kind: 'ice-candidate',
        negotiationId: DEFAULT_NEGOTIATION_ID,
        candidate: { candidate: 'candidate:test', secret: 'must-not-pass' },
      },
    }))
    expect((await client.next('error')).code).toBe('invalid_message')

    client.socket.send(Buffer.from(JSON.stringify({ type: 'ping' })))
    expect((await client.next('error')).code).toBe('invalid_message')

    send(client.socket, { type: 'ping' })
    await expect(client.next('pong')).resolves.toEqual({ type: 'pong' })
    client.socket.close()
  })

  it('enforces global and per-IP WebSocket quotas and releases counters on close', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      trustCloudflareConnectingIp: true,
      security: {
        maxConnections: 2,
        maxConnectionsPerIp: 1,
      },
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`
    const first = await connect(url, {
      headers: { 'CF-Connecting-IP': '198.51.100.1' },
    })

    await expect(
      rejectedUpgradeStatus(
        url,
        SIGNALING_SUBPROTOCOL,
        webSocketOrigin(url),
        { 'CF-Connecting-IP': '198.51.100.1' },
      ),
    ).resolves.toBe(429)
    const second = await connect(url, {
      headers: { 'CF-Connecting-IP': '198.51.100.2' },
    })
    await expect(
      rejectedUpgradeStatus(
        url,
        SIGNALING_SUBPROTOCOL,
        webSocketOrigin(url),
        { 'CF-Connecting-IP': '198.51.100.3' },
      ),
    ).resolves.toBe(503)

    await closeSocket(first.socket)
    const replacement = await connect(url, {
      headers: { 'CF-Connecting-IP': '198.51.100.3' },
    })
    send(replacement.socket, { type: 'ping' })
    await expect(replacement.next('pong')).resolves.toEqual({ type: 'pong' })

    second.socket.close()
    replacement.socket.close()
  })

  it('enforces global and per-IP session quotas and releases them on leave', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      trustCloudflareConnectingIp: true,
      security: {
        maxConnections: 8,
        maxConnectionsPerIp: 4,
        maxSessions: 2,
        maxSessionsPerIp: 1,
        createSession: { capacity: 10, refillPerSecond: 1 },
      },
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`
    const [first, sameIp, secondIp, thirdIp] = await Promise.all([
      connect(url, { headers: { 'CF-Connecting-IP': '198.51.100.10' } }),
      connect(url, { headers: { 'CF-Connecting-IP': '198.51.100.10' } }),
      connect(url, { headers: { 'CF-Connecting-IP': '198.51.100.11' } }),
      connect(url, { headers: { 'CF-Connecting-IP': '198.51.100.12' } }),
    ])

    send(first.socket, { type: 'create_session' })
    await first.next('session_created')
    send(sameIp.socket, { type: 'create_session' })
    expect((await sameIp.next('error')).code).toBe('capacity_exceeded')

    send(secondIp.socket, { type: 'create_session' })
    await secondIp.next('session_created')
    send(thirdIp.socket, { type: 'create_session' })
    expect((await thirdIp.next('error')).code).toBe('capacity_exceeded')

    send(first.socket, { type: 'leave_session' })
    send(first.socket, { type: 'ping' })
    await first.next('pong')
    send(sameIp.socket, { type: 'create_session' })
    await sameIp.next('session_created')

    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(await health.json()).toEqual({ status: 'ok', sessions: 2 })
    for (const client of [first, sameIp, secondIp, thirdIp]) client.socket.close()
  })

  it('rate limits session creation without replacing the current session', async () => {
    let currentTime = 1_000
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      now: () => currentTime,
      security: {
        createSession: { capacity: 1, refillPerSecond: 1 },
      },
    })
    runningServers.push(server)
    const port = await server.start()
    const client = await connect(`ws://127.0.0.1:${port}/ws`)

    send(client.socket, { type: 'create_session' })
    const first = await client.next('session_created')
    send(client.socket, { type: 'create_session' })
    expect((await client.next('error')).code).toBe('rate_limited')
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({
      status: 'ok',
      sessions: 1,
    })

    currentTime += 1_000
    send(client.socket, { type: 'create_session' })
    const replacement = await client.next('session_created')
    expect(replacement.code).not.toBe(first.code)
    client.socket.close()
  })

  it('terminates repeated malformed-message abuse while preserving valid traffic', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      security: {
        invalidMessage: { capacity: 2, refillPerSecond: 0.01 },
      },
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`
    const client = await connect(url)

    client.socket.send('{')
    expect((await client.next('error')).code).toBe('invalid_message')
    client.socket.send(JSON.stringify({ type: 'unknown' }))
    expect((await client.next('error')).code).toBe('invalid_message')

    const closed = waitForSocketClose(client.socket)
    client.socket.send(Buffer.from(JSON.stringify({ type: 'ping' })))
    await closed

    const replacement = await connect(url)
    send(replacement.socket, { type: 'ping' })
    await expect(replacement.next('pong')).resolves.toEqual({ type: 'pong' })
    const replacementClosed = waitForSocketClose(replacement.socket)
    replacement.socket.send('{')
    await replacementClosed
  })

  it('survives deep JSON, oversized frames, and invalid UTF-8 text', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`
    const client = await connect(url)

    client.socket.send('x'.repeat(MAX_SIGNALING_MESSAGE_BYTES))
    expect((await client.next('error')).code).toBe('invalid_message')
    const nested = `${'['.repeat(10_000)}null${']'.repeat(10_000)}`
    client.socket.send(`{"type":"signal","payload":${nested}}`)
    expect((await client.next('error')).code).toBe('invalid_message')
    client.socket.send(JSON.stringify({
      type: 'signal',
      payload: {
        kind: 'session-description',
        negotiationId: DEFAULT_NEGOTIATION_ID,
        description: { type: 'offer', sdp: '"'.repeat(60 * 1024) },
      },
    }))
    expect((await client.next('error')).code).toBe('not_authorized')
    send(client.socket, { type: 'ping' })
    await client.next('pong')

    const oversizedClose = waitForSocketCloseCode(client.socket)
    client.socket.send('x'.repeat(MAX_SIGNALING_MESSAGE_BYTES + 1))
    await expect(oversizedClose).resolves.toBe(1009)

    const invalidUtf8 = await connect(url)
    const utf8Close = waitForSocketCloseCode(invalidUtf8.socket)
    invalidUtf8.socket.send(Buffer.from([0xff]), { binary: false })
    await expect(utf8Close).resolves.toBe(1007)

    const survivor = await connect(url)
    send(survivor.socket, { type: 'ping' })
    await survivor.next('pong')
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({
      status: 'ok',
      sessions: 0,
    })
    survivor.socket.close()
  })

  it('rate limits resume attempts before token lookup', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      security: {
        resumeSession: { capacity: 1, refillPerSecond: 0.01 },
      },
    })
    runningServers.push(server)
    const port = await server.start()
    const client = await connect(`ws://127.0.0.1:${port}/ws`)
    const token = 'A'.repeat(43)

    send(client.socket, { type: 'resume_session', token })
    expect((await client.next('error')).code).toBe('invalid_resume')
    send(client.socket, { type: 'resume_session', token })
    expect((await client.next('error')).code).toBe('rate_limited')
    client.socket.close()
  })

  it('applies global create limits across distinct trusted client IPs', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      trustCloudflareConnectingIp: true,
      security: {
        maxConnections: 4,
        maxConnectionsPerIp: 2,
        maxSessions: 4,
        maxSessionsPerIp: 2,
        createSession: { capacity: 10, refillPerSecond: 1 },
        globalCreateSession: { capacity: 1, refillPerSecond: 0.01 },
      },
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`
    const [first, second] = await Promise.all([
      connect(url, { headers: { 'CF-Connecting-IP': '198.51.100.20' } }),
      connect(url, { headers: { 'CF-Connecting-IP': '198.51.100.21' } }),
    ])

    send(first.socket, { type: 'create_session' })
    await first.next('session_created')
    send(second.socket, { type: 'create_session' })
    const limited = await second.next('error')
    expect(limited).toMatchObject({
      code: 'rate_limited',
      operation: 'create_session',
      retryAfterSeconds: 15,
    })
    first.socket.close()
    second.socket.close()
  })

  it('rejects resume on a socket already bound to another session', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`
    const [firstHost, firstGuest, secondHost, secondGuest] = await Promise.all([
      connect(url),
      connect(url),
      connect(url),
      connect(url),
    ])
    await approveExistingPair(firstHost, firstGuest)
    const second = await approveExistingPair(secondHost, secondGuest)

    send(firstHost.socket, {
      type: 'resume_session',
      token: second.joined.resumeToken,
    })
    expect((await firstHost.next('error')).code).toBe('invalid_resume')

    const firstOffer = descriptionSignal('offer', 'first-still-active')
    send(firstHost.socket, { type: 'signal', payload: firstOffer })
    expect((await firstGuest.next('signal')).payload).toEqual(firstOffer)
    const secondOffer = descriptionSignal('offer', 'second-still-active')
    send(secondHost.socket, { type: 'signal', payload: secondOffer })
    expect((await secondGuest.next('signal')).payload).toEqual(secondOffer)

    for (const client of [firstHost, firstGuest, secondHost, secondGuest]) {
      client.socket.close()
    }
  })

  it('creates a session, requests consent, then pairs two clients', async () => {
    const { host, guest } = await connectPair()

    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')

    send(guest.socket, { type: 'join_session', code: created.code })
    const [pending, incoming] = await Promise.all([
      guest.next('join_pending'),
      host.next('incoming_request'),
    ])
    expect(pending.requestId).toBe(incoming.requestId)

    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'control',
    })

    const [approved, joined] = await Promise.all([
      guest.next('session_approved'),
      host.next('peer_joined'),
    ])
    expect(approved.code).toBe(created.code)
    expect(approved.peerId).toBe(host.clientId)
    expect(approved.accessMode).toBe('control')
    expect(approved.resumeToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(approved.reconnectGraceSeconds).toBe(30)
    expect(approved.iceConfiguration).toEqual({
      version: 1,
      expiresAt: null,
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
    })
    expect(joined.accessMode).toBe('control')
    expect(joined.resumeToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(joined.resumeToken).not.toBe(approved.resumeToken)
    expect(joined.peerId).toBe(guest.clientId)
    expect(joined.iceConfiguration).toEqual(approved.iceConfiguration)

    host.socket.close()
    guest.socket.close()
  })

  it('does not pair a guest when the host rejects consent', async () => {
    const { host, guest } = await connectPair()
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')

    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: false,
    })

    await expect(guest.next('request_rejected')).resolves.toEqual({
      type: 'request_rejected',
    })

    host.socket.close()
    guest.socket.close()
  })

  it('requires an explicit access mode for an approved request', async () => {
    const { host, guest } = await connectPair()
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')

    host.socket.send(
      JSON.stringify({
        type: 'request_decision',
        requestId: incoming.requestId,
        approved: true,
      }),
    )

    const error = await host.next('error')
    expect(error.code).toBe('invalid_message')

    host.socket.close()
    guest.socket.close()
  })

  it('relays signaling only after consent', async () => {
    const { host, guest } = await connectPair()
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')

    send(guest.socket, { type: 'signal', payload: candidateSignal('early') })
    const denied = await guest.next('error')
    expect(denied.code).toBe('not_authorized')

    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'view',
    })
    await Promise.all([host.next('peer_joined'), guest.next('session_approved')])

    const offer = descriptionSignal('offer', 'test-offer-sdp')
    send(host.socket, { type: 'signal', payload: offer })
    const relayedOffer = await guest.next('signal')
    expect(relayedOffer.from).toBe(host.clientId)
    expect(relayedOffer.payload).toEqual(offer)

    const answer = descriptionSignal('answer', 'test-answer-sdp')
    send(guest.socket, { type: 'signal', payload: answer })
    const relayedAnswer = await host.next('signal')
    expect(relayedAnswer.from).toBe(guest.clientId)
    expect(relayedAnswer.payload).toEqual(answer)

    const hostCandidate = candidateSignal('candidate:host')
    send(host.socket, { type: 'signal', payload: hostCandidate })
    expect((await guest.next('signal')).payload).toEqual(hostCandidate)
    const guestCandidate = candidateSignal('candidate:guest')
    send(guest.socket, { type: 'signal', payload: guestCandidate })
    expect((await host.next('signal')).payload).toEqual(guestCandidate)

    host.socket.close()
    guest.socket.close()
  })

  it('rejects reversed bare and native-video SDP directions without relay', async () => {
    const { host, guest } = await connectApprovedPair()

    for (const payload of [
      descriptionSignal('offer', 'guest-offer'),
      nativeDescriptionSignal('offer', 'guest-native-offer'),
    ]) {
      send(guest.socket, { type: 'signal', payload })
      expect((await guest.next('error')).code).toBe('not_authorized')
      send(host.socket, { type: 'ping' })
      await expect(host.nextAny()).resolves.toEqual({ type: 'pong' })
    }

    for (const payload of [
      descriptionSignal('answer', 'host-answer'),
      nativeDescriptionSignal('answer', 'host-native-answer'),
    ]) {
      send(host.socket, { type: 'signal', payload })
      expect((await host.next('error')).code).toBe('not_authorized')
      send(guest.socket, { type: 'ping' })
      await expect(guest.nextAny()).resolves.toEqual({ type: 'pong' })
    }

    const nativeOffer = nativeDescriptionSignal('offer', 'native-offer')
    send(host.socket, { type: 'signal', payload: nativeOffer })
    expect((await guest.next('signal')).payload).toEqual(nativeOffer)
    const nativeAnswer = nativeDescriptionSignal('answer', 'native-answer')
    send(guest.socket, { type: 'signal', payload: nativeAnswer })
    expect((await host.next('signal')).payload).toEqual(nativeAnswer)

    host.socket.close()
    guest.socket.close()
  })

  it('isolates negotiation epochs per lane and drops stale signal replay', async () => {
    const { host, guest } = await connectApprovedPair()
    const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

    send(guest.socket, {
      type: 'signal',
      payload: candidateSignal('candidate:before-offer', firstId),
    })
    send(host.socket, { type: 'ping' })
    await expect(host.nextAny()).resolves.toEqual({ type: 'pong' })

    const firstOffer = descriptionSignal('offer', 'offer-a', firstId)
    send(host.socket, { type: 'signal', payload: firstOffer })
    expect((await guest.next('signal')).payload).toEqual(firstOffer)
    const firstAnswer = descriptionSignal('answer', 'answer-a', firstId)
    send(guest.socket, { type: 'signal', payload: firstAnswer })
    expect((await host.next('signal')).payload).toEqual(firstAnswer)

    send(guest.socket, { type: 'signal', payload: firstAnswer })
    send(host.socket, { type: 'ping' })
    await expect(host.nextAny()).resolves.toEqual({ type: 'pong' })

    const nativeOffer = nativeDescriptionSignal('offer', 'native-offer', firstId)
    send(host.socket, { type: 'signal', payload: nativeOffer })
    expect((await guest.next('signal')).payload).toEqual(nativeOffer)

    const secondOffer = descriptionSignal('offer', 'offer-b', secondId)
    send(host.socket, { type: 'signal', payload: secondOffer })
    expect((await guest.next('signal')).payload).toEqual(secondOffer)

    for (const stalePayload of [
      candidateSignal('candidate:stale', firstId),
      firstOffer,
    ]) {
      send(host.socket, { type: 'signal', payload: stalePayload })
      send(guest.socket, { type: 'ping' })
      await expect(guest.nextAny()).resolves.toEqual({ type: 'pong' })
    }
    send(guest.socket, { type: 'signal', payload: firstAnswer })
    send(host.socket, { type: 'ping' })
    await expect(host.nextAny()).resolves.toEqual({ type: 'pong' })

    const secondAnswer = descriptionSignal('answer', 'answer-b', secondId)
    send(guest.socket, { type: 'signal', payload: secondAnswer })
    expect((await host.next('signal')).payload).toEqual(secondAnswer)
    const secondHostCandidate = candidateSignal('candidate:host-b', secondId)
    send(host.socket, { type: 'signal', payload: secondHostCandidate })
    expect((await guest.next('signal')).payload).toEqual(secondHostCandidate)
    const secondGuestCandidate = candidateSignal('candidate:guest-b', secondId)
    send(guest.socket, { type: 'signal', payload: secondGuestCandidate })
    expect((await host.next('signal')).payload).toEqual(secondGuestCandidate)

    const nativeAnswer = nativeDescriptionSignal(
      'answer',
      'native-answer',
      firstId,
    )
    send(guest.socket, { type: 'signal', payload: nativeAnswer })
    expect((await host.next('signal')).payload).toEqual(nativeAnswer)
    const nativeHostCandidate = nativeCandidateSignal(
      'candidate:native-host',
      firstId,
    )
    send(host.socket, { type: 'signal', payload: nativeHostCandidate })
    expect((await guest.next('signal')).payload).toEqual(nativeHostCandidate)
    const nativeGuestCandidate = nativeCandidateSignal(
      'candidate:native-guest',
      firstId,
    )
    send(guest.socket, { type: 'signal', payload: nativeGuestCandidate })
    expect((await host.next('signal')).payload).toEqual(nativeGuestCandidate)

    host.socket.close()
    guest.socket.close()
  })

  it('does not consume an offer ID while its recipient is suspended', async () => {
    const { host, guest, url, approved } = await connectApprovedPair()
    const negotiationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const offer = descriptionSignal('offer', 'offline-offer', negotiationId)

    guest.socket.close()
    await host.next('peer_suspended')

    send(host.socket, { type: 'signal', payload: offer })
    expect(await host.next('error')).toMatchObject({ code: 'peer_unavailable' })

    const resumedGuest = await connect(url)
    send(resumedGuest.socket, {
      type: 'resume_session',
      token: approved.resumeToken,
    })
    await Promise.all([
      resumedGuest.next('session_resumed'),
      host.next('peer_resumed'),
    ])

    send(host.socket, { type: 'signal', payload: offer })
    expect((await resumedGuest.next('signal')).payload).toEqual(offer)

    host.socket.close()
    resumedGuest.socket.close()
  })

  it('preserves negotiation replay state across host resume', async () => {
    const { host, guest, url, joined } = await connectApprovedPair()
    const firstId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const secondId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const firstOffer = descriptionSignal('offer', 'resume-offer-a', firstId)
    const firstAnswer = descriptionSignal('answer', 'resume-answer-a', firstId)

    send(host.socket, { type: 'signal', payload: firstOffer })
    expect((await guest.next('signal')).payload).toEqual(firstOffer)
    send(guest.socket, { type: 'signal', payload: firstAnswer })
    expect((await host.next('signal')).payload).toEqual(firstAnswer)

    host.socket.close()
    await guest.next('peer_suspended')
    const resumedHost = await connect(url)
    send(resumedHost.socket, {
      type: 'resume_session',
      token: joined.resumeToken,
    })
    await Promise.all([
      resumedHost.next('session_resumed'),
      guest.next('peer_resumed'),
    ])

    send(resumedHost.socket, { type: 'signal', payload: firstOffer })
    send(guest.socket, { type: 'ping' })
    await expect(guest.nextAny()).resolves.toEqual({ type: 'pong' })

    const secondOffer = descriptionSignal('offer', 'resume-offer-b', secondId)
    const secondAnswer = descriptionSignal('answer', 'resume-answer-b', secondId)
    send(resumedHost.socket, { type: 'signal', payload: secondOffer })
    expect((await guest.next('signal')).payload).toEqual(secondOffer)
    send(guest.socket, { type: 'signal', payload: secondAnswer })
    expect((await resumedHost.next('signal')).payload).toEqual(secondAnswer)

    resumedHost.socket.close()
    guest.socket.close()
  })

  it('bounds seen negotiation IDs per lane and reports exhaustion without IDs', async () => {
    const { host, guest } = await connectApprovedPair({
      security: {
        inboundMessages: { capacity: 1_024, refillPerSecond: 1_024 },
        signalMessages: { capacity: 1_024, refillPerSecond: 1_024 },
      },
    })

    const offers: SignalingPayload[] = []
    for (let index = 0; index < 256; index += 1) {
      const negotiationId = negotiationIdForIndex(index)
      const offer = descriptionSignal('offer', `bounded-offer-${index}`, negotiationId)
      offers.push(offer)
      send(host.socket, { type: 'signal', payload: offer })
    }
    for (const offer of offers) {
      expect((await guest.next('signal')).payload).toEqual(offer)
    }

    const exhaustedId = negotiationIdForIndex(256)
    send(host.socket, {
      type: 'signal',
      payload: descriptionSignal('offer', 'exhausted-offer', exhaustedId),
    })
    const exhausted = await host.next('error')
    expect(exhausted).toMatchObject({ code: 'negotiation_exhausted' })
    expect(Object.keys(exhausted).sort()).toEqual(['code', 'message', 'type'])
    expect(JSON.stringify(exhausted)).not.toContain(exhaustedId)

    const nativeOffer = nativeDescriptionSignal(
      'offer',
      'independent-native-offer',
      DEFAULT_NATIVE_NEGOTIATION_ID,
    )
    send(host.socket, { type: 'signal', payload: nativeOffer })
    expect((await guest.next('signal')).payload).toEqual(nativeOffer)

    host.socket.close()
    guest.socket.close()
  }, 10_000)

  it('issues distinct TURN credentials only after host consent', async () => {
    const now = Date.parse('2026-07-23T12:00:00.000Z')
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      now: () => now,
      ice: {
        stunUrls: ['stun:stun.example.test:3478'],
        turnUrls: ['turn:turn.example.test:3478?transport=udp'],
        turnSharedSecret: 'test-shared-secret',
        turnCredentialTtlSeconds: 600,
      },
    })
    runningServers.push(server)
    const port = await server.start()
    const [host, guest] = await Promise.all([
      connect(`ws://127.0.0.1:${port}/ws`),
      connect(`ws://127.0.0.1:${port}/ws`),
    ])

    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'view',
    })

    const [approved, joined] = await Promise.all([
      guest.next('session_approved'),
      host.next('peer_joined'),
    ])
    const guestTurn = approved.iceConfiguration.iceServers[1]
    const hostTurn = joined.iceConfiguration.iceServers[1]
    expect(approved.iceConfiguration.expiresAt).toBe('2026-07-23T12:10:00.000Z')
    expect(guestTurn.username).toContain(guest.clientId)
    expect(hostTurn.username).toContain(host.clientId)
    expect(guestTurn.username).not.toBe(hostTurn.username)
    expect(guestTurn.credential).not.toBe(hostTurn.credential)

    host.socket.close()
    guest.socket.close()
  })

  it('invalidates a one-time code after an approved guest leaves', async () => {
    const { host, guest, url } = await connectPair()
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'view',
    })
    await Promise.all([host.next('peer_joined'), guest.next('session_approved')])

    send(guest.socket, { type: 'leave_session' })
    await host.next('peer_left')

    const secondGuest = await connect(url)
    send(secondGuest.socket, { type: 'join_session', code: created.code })
    const error = await secondGuest.next('error')
    expect(error.code).toBe('invalid_code')

    host.socket.close()
    secondGuest.socket.close()
  })

  it('persists a host control revocation across resume without stopping peer signaling', async () => {
    const { host, guest, url } = await connectPair()
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'control',
    })
    const [approved, joined] = await Promise.all([
      guest.next('session_approved'),
      host.next('peer_joined'),
    ])
    expect(approved.accessMode).toBe('control')

    send(host.socket, {
      type: 'revoke_control',
      channel: 'control',
      version: 1,
    })
    send(host.socket, {
      type: 'revoke_control',
      channel: 'control',
      version: 1,
    })
    send(host.socket, { type: 'ping' })
    await expect(host.nextAny()).resolves.toEqual({ type: 'pong' })

    const offerPayload = descriptionSignal('offer', 'control-revocation-offer')
    send(host.socket, { type: 'signal', payload: offerPayload })
    expect((await guest.next('signal')).payload).toEqual(offerPayload)

    const answerPayload = descriptionSignal('answer', 'control-revocation-answer')
    send(guest.socket, { type: 'signal', payload: answerPayload })
    expect((await host.next('signal')).payload).toEqual(answerPayload)

    const livePayload = candidateSignal('after-control-revocation')
    send(guest.socket, { type: 'signal', payload: livePayload })
    expect((await host.next('signal')).payload).toEqual(livePayload)

    host.socket.close()
    await guest.next('peer_suspended')
    const resumedHost = await connect(url)
    send(resumedHost.socket, {
      type: 'resume_session',
      token: joined.resumeToken,
    })
    const [resumed, peerResumed] = await Promise.all([
      resumedHost.next('session_resumed'),
      guest.next('peer_resumed'),
    ])
    expect(resumed.role).toBe('host')
    expect(resumed.accessMode).toBe('view')
    expect(peerResumed.peerId).toBe(host.clientId)

    const resumedPayload = candidateSignal('after-view-only-resume')
    send(resumedHost.socket, { type: 'signal', payload: resumedPayload })
    expect((await guest.next('signal')).payload).toEqual(resumedPayload)

    resumedHost.socket.close()
    guest.socket.close()
  })

  it('validates the bounded control revocation shape, active session, and host role', async () => {
    const { host, guest } = await connectPair()
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')

    send(host.socket, {
      type: 'revoke_control',
      channel: 'control',
      version: 1,
    })
    expect((await host.next('error')).code).toBe('not_authorized')

    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'control',
    })
    await Promise.all([host.next('peer_joined'), guest.next('session_approved')])

    send(guest.socket, {
      type: 'revoke_control',
      channel: 'control',
      version: 1,
    })
    expect((await guest.next('error')).code).toBe('not_authorized')

    host.socket.send(JSON.stringify({
      type: 'revoke_control',
      channel: 'control',
      version: 2,
    }))
    expect((await host.next('error')).code).toBe('invalid_message')

    host.socket.send(JSON.stringify({
      type: 'revoke_control',
      channel: 'control',
      version: 1,
      reason: 'unexpected-field',
    }))
    expect((await host.next('error')).code).toBe('invalid_message')

    host.socket.close()
    guest.socket.close()
  })

  it('resumes an approved guest within the grace period and rotates its token', async () => {
    const { host, guest, url } = await connectPair()
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'control',
    })
    const [approved] = await Promise.all([
      guest.next('session_approved'),
      host.next('peer_joined'),
    ])

    guest.socket.close()
    const suspended = await host.next('peer_suspended')
    expect(Date.parse(suspended.reconnectUntil)).toBeGreaterThan(Date.now())

    const resumedGuest = await connect(url)
    send(resumedGuest.socket, {
      type: 'resume_session',
      token: approved.resumeToken,
    })
    const [resumed, peerResumed] = await Promise.all([
      resumedGuest.next('session_resumed'),
      host.next('peer_resumed'),
    ])
    expect(resumed.role).toBe('guest')
    expect(resumed.code).toBe(created.code)
    expect(resumed.peerConnected).toBe(true)
    expect(resumed.resumeToken).not.toBe(approved.resumeToken)
    expect(peerResumed.peerId).toBe(guest.clientId)

    const replayClient = await connect(url)
    send(replayClient.socket, {
      type: 'resume_session',
      token: approved.resumeToken,
    })
    expect((await replayClient.next('error')).code).toBe('invalid_resume')

    const offerPayload = descriptionSignal('offer', 'resumed-guest-offer')
    send(host.socket, { type: 'signal', payload: offerPayload })
    expect((await resumedGuest.next('signal')).payload).toEqual(offerPayload)

    const answerPayload = descriptionSignal('answer', 'resumed-guest-answer')
    send(resumedGuest.socket, { type: 'signal', payload: answerPayload })
    expect((await host.next('signal')).payload).toEqual(answerPayload)

    const payload = candidateSignal('ice-restart-probe')
    send(resumedGuest.socket, { type: 'signal', payload })
    expect((await host.next('signal')).payload).toEqual(payload)

    host.socket.close()
    resumedGuest.socket.close()
    replayClient.socket.close()
  })

  it('replaces a stale active socket when the current reconnect token is presented', async () => {
    const { host, guest, url } = await connectPair()
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'view',
    })
    const [approved] = await Promise.all([
      guest.next('session_approved'),
      host.next('peer_joined'),
    ])

    const replacement = await connect(url)
    send(replacement.socket, {
      type: 'resume_session',
      token: approved.resumeToken,
    })
    const [resumed, peerResumed] = await Promise.all([
      replacement.next('session_resumed'),
      host.next('peer_resumed'),
    ])
    expect(resumed.peerConnected).toBe(true)
    expect(resumed.resumeToken).not.toBe(approved.resumeToken)
    expect(peerResumed.peerId).toBe(guest.clientId)
    await expect(
      new Promise<void>((resolve) => guest.socket.once('close', () => resolve())),
    ).resolves.toBeUndefined()

    host.socket.close()
    replacement.socket.close()
  })

  it('terminates a websocket that stops answering heartbeat pings', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      heartbeatIntervalMs: 100,
    })
    runningServers.push(server)
    const port = await server.start()
    const heartbeatUrl = `ws://127.0.0.1:${port}/ws`
    const socket = new WebSocket(heartbeatUrl, SIGNALING_SUBPROTOCOL, {
      autoPong: false,
      origin: webSocketOrigin(heartbeatUrl),
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })

    await expect(
      new Promise<void>((resolve) => socket.once('close', () => resolve())),
    ).resolves.toBeUndefined()
  })

  it('expires a suspended approved session after the reconnect grace period', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      reconnectGraceMs: 1_000,
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`
    const [host, guest] = await Promise.all([connect(url), connect(url)])
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'view',
    })
    const [approved] = await Promise.all([
      guest.next('session_approved'),
      host.next('peer_joined'),
    ])

    guest.socket.close()
    await host.next('peer_suspended')
    expect((await host.next('session_ended')).reason).toBe('reconnect_timeout')

    const lateGuest = await connect(url)
    send(lateGuest.socket, {
      type: 'resume_session',
      token: approved.resumeToken,
    })
    expect((await lateGuest.next('error')).code).toBe('invalid_resume')

    host.socket.close()
    lateGuest.socket.close()
  })

  it('resumes both peers after a simultaneous disconnect', async () => {
    const { host, guest, url } = await connectPair()
    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'control',
    })
    const [approved, joined] = await Promise.all([
      guest.next('session_approved'),
      host.next('peer_joined'),
    ])

    host.socket.close()
    await guest.next('peer_suspended')
    guest.socket.close()

    const resumedHost = await connect(url)
    send(resumedHost.socket, {
      type: 'resume_session',
      token: joined.resumeToken,
    })
    const hostResume = await resumedHost.next('session_resumed')
    expect(hostResume.role).toBe('host')
    expect(hostResume.peerConnected).toBe(false)
    expect(hostResume.resumeToken).not.toBe(joined.resumeToken)

    const resumedGuest = await connect(url)
    send(resumedGuest.socket, {
      type: 'resume_session',
      token: approved.resumeToken,
    })
    const [guestResume, peerResumed] = await Promise.all([
      resumedGuest.next('session_resumed'),
      resumedHost.next('peer_resumed'),
    ])
    expect(guestResume.role).toBe('guest')
    expect(guestResume.peerConnected).toBe(true)
    expect(peerResumed.peerId).toBe(guest.clientId)

    const payload = descriptionSignal('offer', 'both-peers-resumed')
    send(resumedHost.socket, { type: 'signal', payload })
    expect((await resumedGuest.next('signal')).payload).toEqual(payload)

    resumedHost.socket.close()
    resumedGuest.socket.close()
  })

  it('refreshes ICE credentials only for an approved member', async () => {
    let currentTime = Date.parse('2026-07-23T12:00:00.000Z')
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: null,
      now: () => currentTime,
      ice: {
        stunUrls: ['stun:stun.example.test:3478'],
        turnUrls: ['turn:turn.example.test:3478?transport=udp'],
        turnSharedSecret: 'test-shared-secret',
        turnCredentialTtlSeconds: 600,
      },
    })
    runningServers.push(server)
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/ws`
    const [host, guest] = await Promise.all([connect(url), connect(url)])

    send(guest.socket, { type: 'refresh_ice' })
    expect((await guest.next('error')).code).toBe('not_authorized')

    send(host.socket, { type: 'create_session' })
    const created = await host.next('session_created')
    send(guest.socket, { type: 'join_session', code: created.code })
    const incoming = await host.next('incoming_request')
    send(host.socket, {
      type: 'request_decision',
      requestId: incoming.requestId,
      approved: true,
      accessMode: 'view',
    })
    const [approved] = await Promise.all([
      guest.next('session_approved'),
      host.next('peer_joined'),
    ])

    currentTime += 60_000
    send(guest.socket, { type: 'refresh_ice' })
    const refreshed = await guest.next('ice_configuration')
    expect(refreshed.iceConfiguration.expiresAt).toBe(
      '2026-07-23T12:11:00.000Z',
    )
    expect(refreshed.iceConfiguration.iceServers[1]?.username).not.toBe(
      approved.iceConfiguration.iceServers[1]?.username,
    )

    host.socket.close()
    guest.socket.close()
  })

  it('preserves member signal and ICE rate debt across active socket takeover', async () => {
    let currentTime = 1_000
    const pair = await connectApprovedPair({
      now: () => currentTime,
      security: {
        signalMessages: { capacity: 1, refillPerSecond: 0.01 },
        signalBytes: { capacity: 64 * 1024, refillPerSecond: 1_024 },
        refreshIce: { capacity: 1, refillPerSecond: 0.01 },
      },
    })

    const firstOffer = descriptionSignal('offer', 'initial-offer')
    send(pair.host.socket, { type: 'signal', payload: firstOffer })
    expect((await pair.guest.next('signal')).payload).toEqual(firstOffer)
    send(pair.guest.socket, { type: 'refresh_ice' })
    await pair.guest.next('ice_configuration')

    const resumedHost = await connect(pair.url)
    send(resumedHost.socket, {
      type: 'resume_session',
      token: pair.joined.resumeToken,
    })
    await Promise.all([
      resumedHost.next('session_resumed'),
      pair.guest.next('peer_resumed'),
    ])

    const resumedGuest = await connect(pair.url)
    send(resumedGuest.socket, {
      type: 'resume_session',
      token: pair.approved.resumeToken,
    })
    await Promise.all([
      resumedGuest.next('session_resumed'),
      resumedHost.next('peer_resumed'),
    ])

    send(resumedHost.socket, {
      type: 'signal',
      payload: candidateSignal('still-rate-limited'),
    })
    expect(await resumedHost.next('error')).toMatchObject({
      code: 'rate_limited',
      operation: 'signal',
    })
    send(resumedGuest.socket, { type: 'refresh_ice' })
    expect(await resumedGuest.next('error')).toMatchObject({
      code: 'rate_limited',
      operation: 'refresh_ice',
    })

    currentTime += 100_000
    const candidate = candidateSignal('refilled-after-takeover')
    send(resumedHost.socket, { type: 'signal', payload: candidate })
    expect((await resumedGuest.next('signal')).payload).toEqual(candidate)
    send(resumedGuest.socket, { type: 'refresh_ice' })
    await resumedGuest.next('ice_configuration')

    resumedHost.socket.close()
    resumedGuest.socket.close()
  })

  it('bounds signaling byte volume separately from message count', async () => {
    const { host, guest } = await connectApprovedPair({
      security: {
        signalMessages: { capacity: 10, refillPerSecond: 1 },
        signalBytes: { capacity: 128, refillPerSecond: 1 },
      },
    })

    send(host.socket, {
      type: 'signal',
      payload: descriptionSignal('offer', 'x'.repeat(200)),
    })
    expect(await host.next('error')).toMatchObject({
      code: 'rate_limited',
      operation: 'signal',
    })
    send(guest.socket, { type: 'ping' })
    await expect(guest.nextAny()).resolves.toEqual({ type: 'pong' })
    host.socket.close()
    guest.socket.close()
  })
})

class ControllableSecurityAuditRecorder implements SecurityAuditRecorder {
  readonly events: SecurityAuditEventInput[] = []
  healthy = true
  failEventType: SecurityAuditEventInput['eventType'] | null = null

  get status(): Pick<SecurityAuditFlushResult, 'ok'> {
    return { ok: this.healthy }
  }

  initialize(): Promise<SecurityAuditFlushResult> {
    return Promise.resolve({
      ok: true,
      errorCode: null,
      droppedEntries: 0,
    })
  }

  bucketClientIp(): CoarseClientBucket | null {
    return null
  }

  record(event: SecurityAuditEventInput): SecurityAuditEnqueueResult {
    this.events.push({ ...event } as SecurityAuditEventInput)
    if (event.eventType === this.failEventType) {
      return { accepted: false, reason: 'queue_full' }
    }
    return { accepted: true }
  }

  close(): Promise<SecurityAuditFlushResult> {
    return Promise.resolve({
      ok: true,
      errorCode: null,
      droppedEntries: 0,
    })
  }
}

class CapturingSecurityAuditRecorder implements SecurityAuditRecorder {
  readonly events: SecurityAuditEventInput[] = []

  constructor(private readonly writer: SecurityAuditWriter) {}

  get status(): Pick<SecurityAuditFlushResult, 'ok'> {
    return this.writer.status
  }

  initialize(): Promise<SecurityAuditFlushResult> {
    return this.writer.initialize()
  }

  bucketClientIp(clientIp: string): CoarseClientBucket | null {
    return this.writer.bucketClientIp(clientIp)
  }

  record(event: SecurityAuditEventInput): SecurityAuditEnqueueResult {
    this.events.push({ ...event } as SecurityAuditEventInput)
    return this.writer.record(event)
  }

  close(): Promise<SecurityAuditFlushResult> {
    return this.writer.close()
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ediz-remote-server-audit-'))
  temporaryDirectories.push(directory)
  return directory
}

async function readdirAuditFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((file) =>
    /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file),
  )
}

async function connectPair(options: SignalingServerOptions = {}) {
  const server = createSignalingServer({
    ...options,
    port: 0,
    host: '127.0.0.1',
    staticDir: null,
  })
  runningServers.push(server)
  const port = await server.start()

  const url = `ws://127.0.0.1:${port}/ws`
  const [host, guest] = await Promise.all([connect(url), connect(url)])
  return { host, guest, url }
}

async function connectApprovedPair(options: SignalingServerOptions = {}) {
  const pair = await connectPair(options)
  const approval = await approveExistingPair(pair.host, pair.guest)
  return { ...pair, ...approval }
}

async function approveExistingPair(
  host: Awaited<ReturnType<typeof connect>>,
  guest: Awaited<ReturnType<typeof connect>>,
) {
  send(host.socket, { type: 'create_session' })
  const created = await host.next('session_created')
  send(guest.socket, { type: 'join_session', code: created.code })
  const incoming = await host.next('incoming_request')
  send(host.socket, {
    type: 'request_decision',
    requestId: incoming.requestId,
    approved: true,
    accessMode: 'view',
  })
  const [approved, joined] = await Promise.all([
    guest.next('session_approved'),
    host.next('peer_joined'),
  ])
  return { created, approved, joined }
}

async function connect(
  url: string,
  options: { origin?: string; headers?: Record<string, string> } = {},
) {
  const socket = new WebSocket(url, SIGNALING_SUBPROTOCOL, {
    origin: options.origin ?? webSocketOrigin(url),
    headers: options.headers,
  })
  const queue: ServerMessage[] = []
  const waiters: Array<(message: ServerMessage) => void> = []

  socket.on('message', (data) => {
    const parsed = serverMessageSchema.safeParse(JSON.parse(data.toString()))
    if (!parsed.success) {
      throw new Error(`Server message failed schema validation: ${parsed.error.message}`)
    }
    const message = parsed.data
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else queue.push(message)
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  const nextMessage = async (): Promise<ServerMessage> => {
    const queued = queue.shift()
    if (queued) return queued
    return new Promise((resolve) => waiters.push(resolve))
  }

  const ready = await nextMessage()
  if (ready.type !== 'ready') throw new Error('Expected ready message')
  if (
    ready.protocolVersion !== SIGNALING_PROTOCOL_VERSION ||
    ready.minimumProtocolVersion !== MINIMUM_SIGNALING_PROTOCOL_VERSION
  ) {
    throw new Error('Expected current signaling protocol version')
  }

    return {
      socket,
      clientId: ready.clientId,
      nextAny: nextMessage,
      next: async <T extends ServerMessage['type']>(type: T) => {
      const timeoutAt = Date.now() + 2_000
      while (Date.now() < timeoutAt) {
        const message = await Promise.race([
          nextMessage(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2_000),
          ),
        ])
        if (message.type === type) {
          return message as Extract<ServerMessage, { type: T }>
        }
      }
      throw new Error(`Timed out waiting for ${type}`)
    },
  }
}

function send(socket: WebSocket, message: ClientMessage): void {
  socket.send(JSON.stringify(message))
}

async function rejectedUpgradeStatus(
  url: string,
  protocol: string | undefined,
  origin: string | undefined,
  headers?: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = protocol
      ? new WebSocket(url, protocol, { origin, headers })
      : new WebSocket(url, { origin, headers })
    let settled = false
    socket.once('unexpected-response', (_request, response) => {
      settled = true
      const statusCode = response.statusCode ?? 0
      response.resume()
      resolve(statusCode)
    })
    socket.once('open', () => {
      socket.close()
      reject(new Error('WebSocket upgrade unexpectedly succeeded'))
    })
    socket.once('error', (error) => {
      if (!settled) reject(error)
    })
  })
}

async function closeSocket(socket: WebSocket): Promise<void> {
  const closed = waitForSocketClose(socket)
  socket.close()
  await closed
}

async function waitForSocketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => socket.once('close', () => resolve()))
}

async function waitForSocketCloseCode(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) {
    throw new Error('Socket kapandıktan sonra close kodu beklenemez.')
  }
  return new Promise<number>((resolve) =>
    socket.once('close', (code) => resolve(code)),
  )
}

const DEFAULT_NEGOTIATION_ID = '11111111-1111-4111-8111-111111111111'
const DEFAULT_NATIVE_NEGOTIATION_ID = '22222222-2222-4222-8222-222222222222'

function candidateSignal(
  candidate: string,
  negotiationId = DEFAULT_NEGOTIATION_ID,
): SignalingPayload {
  return {
    kind: 'ice-candidate',
    negotiationId,
    candidate: { candidate },
  }
}

function descriptionSignal(
  type: 'offer' | 'answer',
  sdp: string,
  negotiationId = DEFAULT_NEGOTIATION_ID,
): SignalingPayload {
  return {
    kind: 'session-description',
    negotiationId,
    description: { type, sdp },
  }
}

function nativeDescriptionSignal(
  type: 'offer' | 'answer',
  sdp: string,
  negotiationId = DEFAULT_NATIVE_NEGOTIATION_ID,
): SignalingPayload {
  return {
    channel: 'native-video',
    version: 2,
    signal: {
      kind: 'session-description',
      negotiationId,
      description: { type, sdp },
    },
  }
}

function nativeCandidateSignal(
  candidate: string,
  negotiationId = DEFAULT_NATIVE_NEGOTIATION_ID,
): SignalingPayload {
  return {
    channel: 'native-video',
    version: 2,
    signal: {
      kind: 'ice-candidate',
      negotiationId,
      candidate: { candidate },
    },
  }
}

function negotiationIdForIndex(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

function webSocketOrigin(url: string): string {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.origin
}
