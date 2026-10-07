import { spawnSync } from 'node:child_process'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSecurityAuditWriter } from '../src/securityAuditConfig.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('security audit environment configuration', () => {
  it('is disabled by default outside production', async () => {
    await expect(loadSecurityAuditWriter({ NODE_ENV: 'test' })).resolves.toBeUndefined()
  })

  it('fails closed with a fixed error when production key material is missing', async () => {
    const sentinel = 'ER_SENTINEL_SECRET_KEY_PATH'

    await expect(
      loadSecurityAuditWriter({
        NODE_ENV: 'production',
        SIGNALING_AUDIT_HMAC_KEY_FILE: sentinel,
      }),
    ).rejects.toThrow('Güvenlik audit yapılandırması geçersiz.')

    try {
      await loadSecurityAuditWriter({
        NODE_ENV: 'production',
        SIGNALING_AUDIT_HMAC_KEY_FILE: sentinel,
      })
    } catch (error) {
      expect(String(error)).not.toContain(sentinel)
    }
  })

  it('keeps startup stderr free of a sentinel key path', () => {
    const sentinel = 'ER_SENTINEL_STARTUP_KEY_PATH_203.0.113.77'
    const entrypoint = fileURLToPath(new URL('../src/index.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', 'tsx', entrypoint], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SIGNALING_AUDIT_ENABLED: 'true',
        SIGNALING_AUDIT_HMAC_KEY_FILE: sentinel,
      },
    })

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toBe(
      '{"type":"service.error","code":"startup_failed"}',
    )
  })

  it('loads a dedicated key file and persists only the fixed audit schema', async () => {
    const root = await temporaryDirectory()
    const auditDirectory = join(root, 'audit')
    const keyFile = join(root, 'audit.key')
    const sentinelKey = 'ER_SENTINEL_AUDIT_HMAC_KEY_1234567890'
    await writeFile(keyFile, `${sentinelKey}\n`, { mode: 0o600 })

    const writer = await loadSecurityAuditWriter({
      NODE_ENV: 'production',
      SIGNALING_AUDIT_HMAC_KEY_FILE: keyFile,
      SIGNALING_AUDIT_DIRECTORY: auditDirectory,
      SIGNALING_AUDIT_RETENTION_DAYS: '3',
      EDIZ_REMOTE_BUILD_ID: 'ediz-remote@0.1.0-phase4',
    })
    expect(writer).toBeDefined()
    expect((await writer!.initialize()).ok).toBe(true)
    expect(
      writer!.record({
        eventType: 'upgrade_rejected',
        outcome: 'rejected',
        role: 'unknown',
        reasonCode: 'invalid_origin',
        coarseClientBucket: writer!.bucketClientIp('203.0.113.77'),
      }),
    ).toEqual({ accepted: true })
    expect((await writer!.close()).ok).toBe(true)

    const today = new Date().toISOString().slice(0, 10)
    const contents = await readFile(
      join(auditDirectory, `audit-${today}.jsonl`),
      'utf8',
    )
    expect(contents).not.toContain(sentinelKey)
    expect(contents).not.toContain('203.0.113.77')
    expect(Object.keys(JSON.parse(contents) as object)).toEqual([
      'timestamp',
      'eventType',
      'outcome',
      'role',
      'reasonCode',
      'coarseClientBucket',
      'protocolVersion',
      'buildId',
    ])
  })

  it('rejects a symbolic-link key without exposing its path or contents', async () => {
    const root = await temporaryDirectory()
    const targetKeyPath = join(root, 'ER_SENTINEL_REAL_AUDIT_KEY.key')
    const linkedKeyFile = join(root, 'ER_SENTINEL_LINKED_AUDIT_KEY.key')
    const sentinelKey = 'ER_SENTINEL_SYMLINK_KEY_1234567890'
    if (process.platform === 'win32') {
      await mkdir(targetKeyPath)
      await writeFile(join(targetKeyPath, 'secret'), sentinelKey, {
        mode: 0o600,
      })
      await symlink(targetKeyPath, linkedKeyFile, 'junction')
    } else {
      await writeFile(targetKeyPath, sentinelKey, { mode: 0o600 })
      await symlink(targetKeyPath, linkedKeyFile, 'file')
    }
    expect((await lstat(linkedKeyFile)).isSymbolicLink()).toBe(true)

    await expectFixedConfigurationFailure(
      {
        NODE_ENV: 'production',
        SIGNALING_AUDIT_ENABLED: 'true',
        SIGNALING_AUDIT_HMAC_KEY_FILE: linkedKeyFile,
      },
      [targetKeyPath, linkedKeyFile, sentinelKey],
    )
  })

  it('rejects oversized and non-file keys with a fixed non-secret error', async () => {
    const root = await temporaryDirectory()
    const oversizedKeyFile = join(root, 'ER_SENTINEL_OVERSIZED_AUDIT_KEY.key')
    const keyDirectory = join(root, 'ER_SENTINEL_AUDIT_KEY_DIRECTORY')
    const oversizedSentinel = 'ER_SENTINEL_OVERSIZED_KEY_CONTENT'
    await writeFile(
      oversizedKeyFile,
      Buffer.concat([
        Buffer.from(oversizedSentinel, 'utf8'),
        Buffer.alloc(4_097, 0x41),
      ]),
      { mode: 0o600 },
    )
    await mkdir(keyDirectory)

    await expectFixedConfigurationFailure(
      {
        NODE_ENV: 'production',
        SIGNALING_AUDIT_ENABLED: 'true',
        SIGNALING_AUDIT_HMAC_KEY_FILE: oversizedKeyFile,
      },
      [oversizedKeyFile, oversizedSentinel],
    )
    await expectFixedConfigurationFailure(
      {
        NODE_ENV: 'production',
        SIGNALING_AUDIT_ENABLED: 'true',
        SIGNALING_AUDIT_HMAC_KEY_FILE: keyDirectory,
      },
      [keyDirectory],
    )
  })

  it('rejects a hard-linked audit key', async () => {
    const root = await temporaryDirectory()
    const keyFile = join(root, 'audit.key')
    await writeFile(keyFile, 'G'.repeat(48), { mode: 0o600 })
    await link(keyFile, join(root, 'second-name.key'))

    await expectFixedConfigurationFailure(
      {
        NODE_ENV: 'production',
        SIGNALING_AUDIT_HMAC_KEY_FILE: keyFile,
      },
      [keyFile],
    )
  })

  it.runIf(process.platform !== 'win32')(
    'rejects a group/world-readable audit key',
    async () => {
      const root = await temporaryDirectory()
      const keyFile = join(root, 'ER_SENTINEL_PUBLIC_AUDIT_KEY.key')
      const sentinelKey = 'ER_SENTINEL_PUBLIC_KEY_CONTENT_1234567890'
      await writeFile(keyFile, sentinelKey, { mode: 0o600 })
      await chmod(keyFile, 0o640)

      await expectFixedConfigurationFailure(
        {
          NODE_ENV: 'production',
          SIGNALING_AUDIT_ENABLED: 'true',
          SIGNALING_AUDIT_HMAC_KEY_FILE: keyFile,
        },
        [keyFile, sentinelKey],
      )
    },
  )

  it.each([
    { SIGNALING_AUDIT_ENABLED: 'yes' },
    { SIGNALING_AUDIT_RETENTION_DAYS: '0' },
    { SIGNALING_AUDIT_RETENTION_DAYS: '31' },
    { EDIZ_REMOTE_BUILD_ID: 'unsafe/build' },
  ])('rejects invalid values without echoing them', async (override) => {
    const root = await temporaryDirectory()
    const keyFile = join(root, 'audit.key')
    await writeFile(keyFile, 'A'.repeat(32), { mode: 0o600 })

    await expect(
      loadSecurityAuditWriter({
        SIGNALING_AUDIT_ENABLED: 'true',
        SIGNALING_AUDIT_HMAC_KEY_FILE: keyFile,
        ...override,
      }),
    ).rejects.toThrow('Güvenlik audit yapılandırması geçersiz.')
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ediz-remote-audit-config-'))
  temporaryDirectories.push(directory)
  return directory
}

async function expectFixedConfigurationFailure(
  environment: NodeJS.ProcessEnv,
  prohibitedValues: readonly string[],
): Promise<void> {
  let caught: unknown
  try {
    await loadSecurityAuditWriter(environment)
  } catch (error) {
    caught = error
  }

  expect(String(caught)).toBe(
    'Error: Güvenlik audit yapılandırması geçersiz.',
  )
  for (const prohibitedValue of prohibitedValues) {
    expect(String(caught)).not.toContain(prohibitedValue)
  }
}
