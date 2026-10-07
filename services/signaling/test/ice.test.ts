import { createHmac } from 'node:crypto'
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createIceConfiguration,
  loadIceServiceOptions,
} from '../src/ice.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ICE configuration', () => {
  it('creates a client-specific short-lived coturn credential', () => {
    const now = Date.parse('2026-07-23T12:00:00.000Z')
    const configuration = createIceConfiguration('client-123', now, {
      stunUrls: ['stun:stun.example.test:3478'],
      turnUrls: [
        'turn:turn.example.test:3478?transport=udp',
        'turns:turn.example.test:5349?transport=tcp',
      ],
      turnSharedSecret: 'test-shared-secret',
      turnCredentialTtlSeconds: 600,
    })

    const expiresAtSeconds = Math.floor(now / 1_000) + 600
    const username = `${expiresAtSeconds}:client-123`
    const expectedCredential = createHmac('sha1', 'test-shared-secret')
      .update(username)
      .digest('base64')
    expect(configuration).toEqual({
      version: 1,
      expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
      iceServers: [
        { urls: ['stun:stun.example.test:3478'] },
        {
          urls: [
            'turn:turn.example.test:3478?transport=udp',
            'turns:turn.example.test:5349?transport=tcp',
          ],
          username,
          credential: expectedCredential,
        },
      ],
    })
  })

  it('keeps direct STUN operation when TURN is not configured', () => {
    expect(
      createIceConfiguration('client-123', 0, {
        stunUrls: ['stun:stun.example.test:3478'],
        turnUrls: [],
        turnCredentialTtlSeconds: 3_600,
      }),
    ).toEqual({
      version: 1,
      expiresAt: null,
      iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
    })
  })

  it('rejects partial TURN secret configuration', () => {
    expect(() =>
      loadIceServiceOptions({
        TURN_URLS: 'turn:turn.example.test:3478',
      }),
    ).toThrow('TURN_URLS ve TURN_SHARED_SECRET birlikte yapılandırılmalıdır.')
  })

  it('rejects a weak or example TURN shared secret', () => {
    expect(() =>
      loadIceServiceOptions({
        TURN_URLS: 'turn:turn.example.test:3478',
        TURN_SHARED_SECRET: 'replace-with-a-long-random-secret',
      }),
    ).toThrow(
      'TURN_SHARED_SECRET en az 32 karakterlik rastgele bir değer olmalıdır.',
    )
  })

  it('loads a bounded private TURN secret file without exposing its path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ediz-remote-turn-secret-'))
    temporaryDirectories.push(directory)
    const secretFile = join(directory, 'ER_SENTINEL_TURN_SECRET_PATH.key')
    const secret = 'A'.repeat(48)
    writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 })

    const options = loadIceServiceOptions({
      TURN_URLS: 'turn:turn.example.test:3478',
      TURN_SHARED_SECRET_FILE: secretFile,
    })

    expect(options.turnSharedSecret).toBe(secret)
  })

  it('rejects ambiguous, oversized and public TURN secret files with a fixed error', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ediz-remote-turn-secret-'))
    temporaryDirectories.push(directory)
    const secretFile = join(directory, 'ER_SENTINEL_TURN_SECRET_PATH.key')
    writeFileSync(secretFile, 'B'.repeat(48), { mode: 0o600 })

    expect(() =>
      loadIceServiceOptions({
        TURN_URLS: 'turn:turn.example.test:3478',
        TURN_SHARED_SECRET: 'C'.repeat(48),
        TURN_SHARED_SECRET_FILE: secretFile,
      }),
    ).toThrow('TURN secret yapılandırması geçersiz.')

    writeFileSync(secretFile, 'D'.repeat(4_097), { mode: 0o600 })
    expect(() =>
      loadIceServiceOptions({
        TURN_URLS: 'turn:turn.example.test:3478',
        TURN_SHARED_SECRET_FILE: secretFile,
      }),
    ).toThrow('TURN secret yapılandırması geçersiz.')

    if (process.platform !== 'win32') {
      writeFileSync(secretFile, 'E'.repeat(48), { mode: 0o600 })
      chmodSync(secretFile, 0o640)
      expect(() =>
        loadIceServiceOptions({
          TURN_URLS: 'turn:turn.example.test:3478',
          TURN_SHARED_SECRET_FILE: secretFile,
        }),
      ).toThrow('TURN secret yapılandırması geçersiz.')
    }
  })

  it('rejects a hard-linked TURN secret file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ediz-remote-turn-secret-'))
    temporaryDirectories.push(directory)
    const secretFile = join(directory, 'turn-secret.key')
    writeFileSync(secretFile, 'F'.repeat(48), { mode: 0o600 })
    linkSync(secretFile, join(directory, 'second-name.key'))

    expect(() =>
      loadIceServiceOptions({
        TURN_URLS: 'turn:turn.example.test:3478',
        TURN_SHARED_SECRET_FILE: secretFile,
      }),
    ).toThrow('TURN secret yapılandırması geçersiz.')
  })
})
