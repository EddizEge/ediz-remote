import { createSecretKey } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SecurityAuditWriter,
  isSafeSecurityAuditBuildId,
  type SecurityAuditEventInput,
  type SecurityAuditEnqueueResult,
} from '../src/securityAudit.js'

const temporaryDirectories: string[] = []
const hmacKey = () => createSecretKey(Buffer.alloc(32, 0x5a))

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('security audit writer', () => {
  it('serializes only the fixed allowlist and rejects secret-bearing fields', async () => {
    const directory = await temporaryDirectory()
    const now = new Date('2026-09-03T10:20:30.000Z')
    const writer = new SecurityAuditWriter({
      directory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@phase4.4-test_01',
      protocolVersion: 3,
      now: () => now,
    })
    const rawIp = '198.51.100.42'
    const bucket = writer.bucketClientIp(rawIp)
    expect(bucket).toMatch(/^ip1_[A-Za-z0-9_-]{16}$/)

    const safeEvent: SecurityAuditEventInput = {
      eventType: 'resume_rejected',
      outcome: 'rejected',
      role: 'unknown',
      reasonCode: 'invalid_resume',
      coarseClientBucket: bucket,
    }
    expect(writer.record(safeEvent)).toEqual({ accepted: true })
    expect(writer.status.ok).toBe(true)
    expect(writer.status.pendingEntries).toBe(1)

    const sentinel = 'SENTINEL_DO_NOT_PERSIST_7ee93f'
    expect(await writer.flush()).toEqual({
      ok: true,
      errorCode: null,
      droppedEntries: 0,
    })
    const contents = await readFile(
      join(directory, 'audit-2026-09-03.jsonl'),
      'utf8',
    )
    const lines = contents.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    const persisted = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(Object.keys(persisted)).toEqual([
      'timestamp',
      'eventType',
      'outcome',
      'role',
      'reasonCode',
      'coarseClientBucket',
      'protocolVersion',
      'buildId',
    ])
    expect(persisted).toEqual({
      timestamp: '2026-09-03T10:20:30.000Z',
      ...safeEvent,
      protocolVersion: 3,
      buildId: 'ediz-remote@phase4.4-test_01',
    })
    expect(contents).not.toContain(sentinel)
    expect(contents).not.toContain(rawIp)

    const unsafePayloads: unknown[] = [
      ...[
        'token',
        'code',
        'sdp',
        'ice',
        'credential',
        'ip',
        'exception',
        'sessionId',
        'protocolVersion',
      ].map((prohibitedField) => ({
        ...safeEvent,
        [prohibitedField]: `${sentinel}_${prohibitedField}`,
      })),
      { ...safeEvent, reasonCode: sentinel },
      { ...safeEvent, coarseClientBucket: rawIp },
      {
        ...safeEvent,
        eventType: 'approval_granted',
        outcome: 'rejected',
        role: 'host',
        reasonCode: 'host_decision',
      },
    ]
    for (const unsafePayload of unsafePayloads) {
      const invalidWriter = new SecurityAuditWriter({
        directory,
        ipBucketKey: hmacKey(),
        buildId: 'ediz-remote@invalid-event-test',
        protocolVersion: 3,
        now: () => now,
      })
      const unsafeRecord = invalidWriter.record.bind(invalidWriter) as (
        event: unknown,
      ) => SecurityAuditEnqueueResult
      expect(unsafeRecord(unsafePayload)).toEqual({
        accepted: false,
        reason: 'invalid_event',
      })
      expect(invalidWriter.status).toMatchObject({
        ok: false,
        errorCode: 'audit_invalid_event',
        droppedEntries: 1,
      })
      expect(unsafeRecord(safeEvent)).toEqual({
        accepted: false,
        reason: 'writer_unavailable',
      })
    }

    expect(await readFile(join(directory, 'audit-2026-09-03.jsonl'), 'utf8'))
      .not.toContain(sentinel)
  })

  it('rotates deterministic client buckets at the UTC day boundary', async () => {
    const directory = await temporaryDirectory()
    let now = new Date('2026-09-03T23:59:59.999Z')
    const writer = new SecurityAuditWriter({
      directory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@rotation-test',
      protocolVersion: 3,
      now: () => now,
    })

    const first = writer.bucketClientIp('2001:db8::1')
    const equivalent = writer.bucketClientIp('2001:0db8:0:0:0:0:0:1')
    const other = writer.bucketClientIp('2001:db8::2')
    expect(equivalent).toBe(first)
    expect(other).not.toBe(first)

    now = new Date('2026-09-04T00:00:00.000Z')
    const rotated = writer.bucketClientIp('2001:db8::1')
    expect(rotated).not.toBe(first)
    expect(writer.bucketClientIp('not-an-ip')).toBeNull()

    expect(
      writer.record({
        eventType: 'approval_granted',
        outcome: 'allowed',
        role: 'host',
        reasonCode: 'host_decision',
        coarseClientBucket: first,
      }),
    ).toEqual({ accepted: true })
    expect((await writer.flush()).ok).toBe(true)
    const persisted = JSON.parse(
      await readFile(join(directory, 'audit-2026-09-04.jsonl'), 'utf8'),
    ) as Record<string, unknown>
    expect(persisted.coarseClientBucket).toBeNull()
    expect(writer.status.ok).toBe(true)
  })

  it('resets the bounded issued-bucket registry on each UTC day', async () => {
    const directory = await temporaryDirectory()
    let now = new Date('2026-09-03T12:00:00.000Z')
    const writer = new SecurityAuditWriter({
      directory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@bucket-bound-test',
      protocolVersion: 3,
      now: () => now,
    })

    for (let index = 0; index < 8_192; index += 1) {
      const secondOctet = Math.floor(index / 256)
      const thirdOctet = index % 256
      expect(writer.bucketClientIp(`10.${secondOctet}.${thirdOctet}.1`))
        .not.toBeNull()
    }
    expect(writer.bucketClientIp('10.32.0.1')).toBeNull()

    now = new Date('2026-09-04T00:00:00.000Z')
    expect(writer.bucketClientIp('10.32.0.1')).not.toBeNull()
  })

  it('writes daily files and removes only expired audit files', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'audit-2026-08-31.jsonl'), '{}\n')
    await writeFile(join(directory, 'audit-2026-09-01.jsonl'), '{}\n')
    await writeFile(join(directory, 'audit-2026-09-02.jsonl'), '{}\n')
    await writeFile(join(directory, 'audit-2026-02-30.jsonl'), '{}\n')
    await writeFile(join(directory, 'keep-me.txt'), 'not an audit file')

    const writer = new SecurityAuditWriter({
      directory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@retention-test',
      protocolVersion: 3,
      retentionDays: 2,
      now: () => new Date('2026-09-03T08:00:00.000Z'),
    })
    expect((await writer.initialize()).ok).toBe(true)
    expect((await readdir(directory)).sort()).toEqual([
      'audit-2026-02-30.jsonl',
      'audit-2026-09-02.jsonl',
      'keep-me.txt',
    ])
    expect(
      writer.record({
        eventType: 'approval_granted',
        outcome: 'allowed',
        role: 'host',
        reasonCode: 'host_decision',
        coarseClientBucket: null,
      }),
    ).toEqual({ accepted: true })
    expect((await writer.flush()).ok).toBe(true)

    expect((await readdir(directory)).sort()).toEqual([
      'audit-2026-02-30.jsonl',
      'audit-2026-09-02.jsonl',
      'audit-2026-09-03.jsonl',
      'keep-me.txt',
    ])
  })

  it('applies retention after a UTC day change without audit traffic', async () => {
    vi.useFakeTimers()
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'audit-2026-09-02.jsonl'), '{}\n')
    let now = new Date('2026-09-03T08:00:00.000Z')
    const writer = new SecurityAuditWriter({
      directory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@idle-retention-test',
      protocolVersion: 3,
      retentionDays: 2,
      now: () => now,
    })

    expect((await writer.initialize()).ok).toBe(true)
    expect(await readdir(directory)).toContain('audit-2026-09-02.jsonl')

    now = new Date('2026-09-04T08:00:00.000Z')
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000)
    await writer.flush()

    expect(await readdir(directory)).not.toContain('audit-2026-09-02.jsonl')
    expect((await writer.close()).ok).toBe(true)
  })

  it('reserves queue capacity for lifecycle events and fails on critical loss', async () => {
    const directory = await temporaryDirectory()
    const writer = new SecurityAuditWriter({
      directory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@queue-test',
      protocolVersion: 3,
      maxQueueEntries: 4,
      now: () => new Date('2026-09-03T08:00:00.000Z'),
    })
    const noiseEvent: SecurityAuditEventInput = {
      eventType: 'join_rate_limited',
      outcome: 'rate_limited',
      role: 'unknown',
      reasonCode: 'rate_limited',
      coarseClientBucket: null,
    }
    const criticalEvent: SecurityAuditEventInput = {
      eventType: 'approval_granted',
      outcome: 'allowed',
      role: 'host',
      reasonCode: 'host_decision',
      coarseClientBucket: null,
    }

    expect(writer.record(noiseEvent)).toEqual({ accepted: true })
    expect(writer.record(noiseEvent)).toEqual({ accepted: true })
    expect(writer.record(noiseEvent)).toEqual({ accepted: true })
    expect(writer.record(noiseEvent)).toEqual({
      accepted: false,
      reason: 'emission_limited',
    })
    expect(writer.record(criticalEvent)).toEqual({ accepted: true })
    expect(writer.status).toMatchObject({
      ok: true,
      pendingEntries: 4,
      suppressedEntries: 1,
    })

    expect((await writer.flush()).ok).toBe(true)
    const contents = await readFile(
      join(directory, 'audit-2026-09-03.jsonl'),
      'utf8',
    )
    const lines = contents.trimEnd().split('\n')
    expect(lines).toHaveLength(4)
    expect(lines.some((line) => line.includes('approval_granted'))).toBe(true)

    const overflowDirectory = await temporaryDirectory()
    const overflowWriter = new SecurityAuditWriter({
      directory: overflowDirectory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@critical-overflow-test',
      protocolVersion: 3,
      maxQueueEntries: 2,
      now: () => new Date('2026-09-03T08:00:00.000Z'),
    })
    expect(overflowWriter.record(criticalEvent)).toEqual({ accepted: true })
    expect(overflowWriter.record(criticalEvent)).toEqual({ accepted: true })
    expect(overflowWriter.record(criticalEvent)).toEqual({
      accepted: false,
      reason: 'queue_full',
    })
    expect(overflowWriter.status).toMatchObject({
      ok: false,
      errorCode: 'audit_queue_overflow',
      pendingEntries: 2,
      droppedEntries: 1,
    })

    expect(await overflowWriter.flush()).toEqual({
      ok: false,
      errorCode: 'audit_queue_overflow',
      droppedEntries: 1,
    })
    expect(overflowWriter.status.pendingEntries).toBe(0)
    const overflowContents = await readFile(
      join(overflowDirectory, 'audit-2026-09-03.jsonl'),
      'utf8',
    )
    expect(overflowContents.trimEnd().split('\n')).toHaveLength(2)
  })

  it('suppresses sustained audit emission before it can amplify disk writes', async () => {
    const directory = await temporaryDirectory()
    const writer = new SecurityAuditWriter({
      directory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@emission-test',
      protocolVersion: 3,
      maxQueueEntries: 128,
      now: () => new Date('2026-09-03T08:00:00.000Z'),
    })
    const event: SecurityAuditEventInput = {
      eventType: 'upgrade_rejected',
      outcome: 'rejected',
      role: 'unknown',
      reasonCode: 'unsupported_protocol',
      coarseClientBucket: null,
    }

    for (let index = 0; index < 64; index += 1) {
      expect(writer.record(event)).toEqual({ accepted: true })
    }
    expect(writer.record(event)).toEqual({
      accepted: false,
      reason: 'emission_limited',
    })
    expect(
      writer.record({
        eventType: 'session_ended',
        outcome: 'ended',
        role: 'system',
        reasonCode: 'server_shutdown',
        coarseClientBucket: null,
      }),
    ).toEqual({ accepted: true })
    expect(writer.status.suppressedEntries).toBe(1)
    expect((await writer.flush()).ok).toBe(true)
    const contents = await readFile(
      join(directory, 'audit-2026-09-03.jsonl'),
      'utf8',
    )
    expect(contents.trimEnd().split('\n')).toHaveLength(65)
    expect(contents).toContain('session_ended')
  })

  it('turns filesystem failures into fixed non-secret status without logging', async () => {
    const parent = await temporaryDirectory()
    const blockedDirectory = join(parent, 'not-a-directory')
    await writeFile(blockedDirectory, 'SENTINEL_PATH_CONTENT')
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const writer = new SecurityAuditWriter({
      directory: blockedDirectory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@failure-test',
      protocolVersion: 3,
      now: () => new Date('2026-09-03T08:00:00.000Z'),
    })

    expect(
      writer.record({
        eventType: 'upgrade_rejected',
        outcome: 'rejected',
        role: 'unknown',
        reasonCode: 'invalid_origin',
        coarseClientBucket: null,
      }),
    ).toEqual({ accepted: true })
    expect(await writer.flush()).toEqual({
      ok: false,
      errorCode: 'audit_write_failed',
      droppedEntries: 1,
    })
    expect(writer.status.writeFailures).toBe(1)
    expect(writer.status.ok).toBe(false)
    expect(
      writer.record({
        eventType: 'upgrade_rejected',
        outcome: 'rejected',
        role: 'unknown',
        reasonCode: 'invalid_origin',
        coarseClientBucket: null,
      }),
    ).toEqual({ accepted: false, reason: 'writer_unavailable' })
    expect(consoleLog).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('does not follow audit directory or daily-file links', async () => {
    const parent = await temporaryDirectory()
    const linkedDirectoryTarget = join(parent, 'linked-directory-target')
    const linkedDirectory = join(parent, 'linked-audit-directory')
    await mkdir(linkedDirectoryTarget)
    await symlink(
      linkedDirectoryTarget,
      linkedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const linkedDirectoryWriter = new SecurityAuditWriter({
      directory: linkedDirectory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@linked-directory-test',
      protocolVersion: 3,
      now: () => new Date('2026-09-03T08:00:00.000Z'),
    })
    expect(await linkedDirectoryWriter.initialize()).toMatchObject({
      ok: false,
      errorCode: 'audit_write_failed',
    })
    expect(await readdir(linkedDirectoryTarget)).toEqual([])

    const auditDirectory = join(parent, 'safe-audit-directory')
    await mkdir(auditDirectory)
    const linkedFile = join(auditDirectory, 'audit-2026-09-03.jsonl')
    const linkTarget = join(parent, 'daily-link-target')
    if (process.platform === 'win32') {
      await mkdir(linkTarget)
      await writeFile(join(linkTarget, 'sentinel.txt'), 'SENTINEL_LINK_TARGET')
      await symlink(linkTarget, linkedFile, 'junction')
    } else {
      await writeFile(linkTarget, 'SENTINEL_LINK_TARGET')
      await symlink(linkTarget, linkedFile, 'file')
    }
    expect((await lstat(linkedFile)).isSymbolicLink()).toBe(true)
    const linkedFileWriter = new SecurityAuditWriter({
      directory: auditDirectory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@linked-file-test',
      protocolVersion: 3,
      now: () => new Date('2026-09-03T08:00:00.000Z'),
    })
    expect(await linkedFileWriter.initialize()).toMatchObject({
      ok: false,
      errorCode: 'audit_write_failed',
    })
    const targetContents =
      process.platform === 'win32'
        ? await readFile(join(linkTarget, 'sentinel.txt'), 'utf8')
        : await readFile(linkTarget, 'utf8')
    expect(targetContents).toBe('SENTINEL_LINK_TARGET')
  })

  it('fails closed if the pinned audit directory is replaced the same day', async () => {
    const parent = await temporaryDirectory()
    const directory = join(parent, 'audit-directory')
    const originalDirectory = join(parent, 'original-audit-directory')
    const externalTarget = join(parent, 'external-target')
    await mkdir(directory)
    await mkdir(externalTarget)
    const writer = new SecurityAuditWriter({
      directory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@directory-swap-test',
      protocolVersion: 3,
      now: () => new Date('2026-09-03T08:00:00.000Z'),
    })
    expect((await writer.initialize()).ok).toBe(true)

    await rename(directory, originalDirectory)
    await symlink(
      externalTarget,
      directory,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(
      writer.record({
        eventType: 'session_ended',
        outcome: 'ended',
        role: 'system',
        reasonCode: 'server_shutdown',
        coarseClientBucket: null,
      }),
    ).toEqual({ accepted: true })
    expect(await writer.flush()).toMatchObject({
      ok: false,
      errorCode: 'audit_write_failed',
    })
    expect(await readdir(externalTarget)).toEqual([])
    expect((await writer.close()).ok).toBe(false)
  })

  it('does not restart retention after initialize races with close', async () => {
    vi.useFakeTimers()
    const directory = await temporaryDirectory()
    const writer = new SecurityAuditWriter({
      directory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@initialize-close-test',
      protocolVersion: 3,
      now: () => new Date('2026-09-03T08:00:00.000Z'),
    })

    const [initialized, closed] = await Promise.all([
      writer.initialize(),
      writer.close(),
    ])
    expect(initialized.errorCode).toBeNull()
    expect(closed).toEqual({
      ok: true,
      errorCode: null,
      droppedEntries: 0,
    })
    await rename(directory, `${directory}-moved`)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000)
    expect(writer.status).toMatchObject({
      errorCode: null,
      writeFailures: 0,
      closed: true,
    })
  })

  it('uses private durable files and becomes unhealthy after close', async () => {
    const directory = await temporaryDirectory()
    const writer = new SecurityAuditWriter({
      directory,
      ipBucketKey: hmacKey(),
      buildId: 'ediz-remote@durable-file-test',
      protocolVersion: 3,
      now: () => new Date('2026-09-03T08:00:00.000Z'),
    })
    expect((await writer.initialize()).ok).toBe(true)
    expect(
      writer.record({
        eventType: 'control_revoked',
        outcome: 'allowed',
        role: 'host',
        reasonCode: 'host_request',
        coarseClientBucket: null,
      }),
    ).toEqual({ accepted: true })
    expect((await writer.flush()).ok).toBe(true)

    const filePath = join(directory, 'audit-2026-09-03.jsonl')
    const fileMetadata = await stat(filePath)
    expect(fileMetadata.isFile()).toBe(true)
    if (process.platform !== 'win32') {
      expect(fileMetadata.mode & 0o777).toBe(0o600)
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
    }

    expect((await writer.close()).ok).toBe(true)
    expect(writer.status).toMatchObject({ ok: false, closed: true })
    expect(
      writer.record({
        eventType: 'control_revoked',
        outcome: 'allowed',
        role: 'host',
        reasonCode: 'host_request',
        coarseClientBucket: null,
      }),
    ).toEqual({ accepted: false, reason: 'closed' })
  })

  it('validates retention, queue, key and build metadata with fixed errors', async () => {
    const directory = await temporaryDirectory()
    expect(isSafeSecurityAuditBuildId('ediz-remote@v3.2026-09-03_a1')).toBe(
      true,
    )
    expect(isSafeSecurityAuditBuildId('../secret\nSENTINEL')).toBe(false)

    for (const options of [
      { retentionDays: 0 },
      { retentionDays: 31 },
      { maxQueueEntries: 0 },
      { maxQueueEntries: 10_001 },
      { protocolVersion: 0 },
      { protocolVersion: 256 },
      { buildId: '../secret\nSENTINEL' },
      { ipBucketKey: createSecretKey(Buffer.alloc(16)) },
    ]) {
      let message = ''
      try {
        new SecurityAuditWriter({
          directory,
          ipBucketKey: hmacKey(),
          buildId: 'ediz-remote@valid-build',
          protocolVersion: 3,
          ...options,
        })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toBe('Geçersiz güvenlik audit yapılandırması.')
      expect(message).not.toContain('SENTINEL')
      expect(message).not.toContain(directory)
    }

    for (const unsafeDirectory of [
      parse(process.cwd()).root,
      process.cwd(),
      homedir(),
      tmpdir(),
    ]) {
      expect(
        () =>
          new SecurityAuditWriter({
            directory: unsafeDirectory,
            ipBucketKey: hmacKey(),
            buildId: 'ediz-remote@valid-build',
            protocolVersion: 3,
          }),
      ).toThrow('Geçersiz güvenlik audit yapılandırması.')
    }
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ediz-remote-audit-'))
  temporaryDirectories.push(directory)
  return directory
}
