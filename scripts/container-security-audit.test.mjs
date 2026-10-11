import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ContainerSecurityAuditError,
  IMAGE_LOCK_METADATA,
  IMAGE_LOCKS,
  loadPinnedImageConfiguration,
  parsePinnedImageReference,
  runContainerDeployment,
  runContainerSecurityAudit,
} from './container-security-audit.mjs'

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const SENTINEL_SECRET = 'ER_SENTINEL_CONTAINER_SECRET_123456789'

function temporaryOutputDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ediz-remote-container-test-'))
  t.after(() => {
    assert.match(path.basename(directory), /^ediz-remote-container-test-/u)
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

function temporaryRepositoryRoot(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ediz-remote-repository-test-'))
  mkdirSync(path.join(directory, 'infra', 'coturn'), { recursive: true })
  for (const fileName of [
    '.dockerignore',
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.dev.yml',
  ]) {
    copyFileSync(path.join(REPOSITORY_ROOT, fileName), path.join(directory, fileName))
  }
  copyFileSync(
    path.join(REPOSITORY_ROOT, 'infra', 'coturn', 'compose.yml'),
    path.join(directory, 'infra', 'coturn', 'compose.yml'),
  )
  for (const fileName of ['.dockerignore', 'Dockerfile', 'entrypoint.sh']) {
    copyFileSync(
      path.join(REPOSITORY_ROOT, 'infra', 'coturn', fileName),
      path.join(directory, 'infra', 'coturn', fileName),
    )
  }
  t.after(() => {
    assert.match(path.basename(directory), /^ediz-remote-repository-test-/u)
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

function completed(stdout = '', status = 0) {
  return {
    notFound: false,
    status,
    stderr: SENTINEL_SECRET,
    stdout,
  }
}

function createDirectoryLink(t, target, link) {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('directory link creation is not permitted on this host')
      return false
    }
    throw error
  }
}

function syntheticImageId(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function writeTarOctal(header, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`
  assert.equal(Buffer.byteLength(encoded, 'ascii'), length)
  header.write(encoded, offset, length, 'ascii')
}

function syntheticTarEntry(name, contents) {
  const body = Buffer.from(contents)
  const header = Buffer.alloc(512)
  assert.ok(Buffer.byteLength(name, 'utf8') <= 100)
  header.write(name, 0, 100, 'utf8')
  writeTarOctal(header, 100, 8, 0o644)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, body.length)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let checksum = 0
  for (const byte of header) checksum += byte
  const checksumText = `${checksum.toString(8).padStart(6, '0')}\0 `
  header.write(checksumText, 148, 8, 'ascii')
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, padding])
}

function writeSyntheticDockerArchive(archivePath, runtimeImageId) {
  const configContents = JSON.stringify({ runtimeImageId })
  const configDigest = createHash('sha256')
    .update(configContents)
    .digest('hex')
  const configPath = `blobs/sha256/${configDigest}`
  const manifestContents = JSON.stringify([{
    Config: configPath,
    Layers: [],
    RepoTags: null,
  }])
  writeFileSync(
    archivePath,
    Buffer.concat([
      syntheticTarEntry(configPath, configContents),
      syntheticTarEntry('manifest.json', manifestContents),
      Buffer.alloc(1024),
    ]),
  )
  return `sha256:${configDigest}`
}

function rewriteDeploymentManifest(outputDirectory, mutate) {
  const manifestPath = path.join(outputDirectory, 'container-audit-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  mutate(manifest)
  const contents = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(manifestPath, contents)
  writeFileSync(
    path.join(outputDirectory, 'deployment.env'),
    [
      `EDIZ_REMOTE_APP_IMAGE=${manifest.applicationImage}`,
      `EDIZ_REMOTE_COTURN_IMAGE=${manifest.coturnImage}`,
      `EDIZ_REMOTE_AUDIT_MANIFEST_SHA256=${createHash('sha256')
        .update(contents)
        .digest('hex')}`,
      '',
    ].join('\n'),
  )
}

function createFakeRunner(options = {}) {
  const calls = []
  const callOptions = []
  const archiveImageIds = new Map()
  const activeContainers = new Map()
  const deployedEnvironments = new Map()
  const mutatedArchives = new Set()
  let composeCalls = 0
  const runner = (argumentsList, runnerOptions = {}) => {
    calls.push([...argumentsList])
    callOptions.push({ ...runnerOptions })

    if (argumentsList[0] === 'version') return completed('linux/amd64\n')

    if (argumentsList[0] === 'context') {
      return completed(JSON.stringify(
        options.contextHost ?? 'npipe:////./pipe/docker_engine',
      ))
    }

    if (argumentsList[0] === 'manifest') {
      return completed(JSON.stringify({
        manifests: [
          { platform: { architecture: 'amd64', os: 'linux' } },
          { platform: { architecture: 'arm64', os: 'linux' } },
        ],
      }))
    }

    if (argumentsList[0] === 'pull') {
      if (
        options.scannerUnavailable === true
        && argumentsList.at(-1) === IMAGE_LOCKS.scanner
      ) {
        return completed('', 1)
      }
      return completed()
    }

    if (argumentsList[0] === 'compose') {
      composeCalls += 1
      if (options.composeFailureIndex === composeCalls) return completed('', 1)
      const composeFile = argumentsList[argumentsList.indexOf('--file') + 1]
      const containerName = /infra[\\/]coturn[\\/]compose\.yml$/u.test(composeFile)
        ? 'ediz-remote-coturn'
        : 'ediz-remote'
      deployedEnvironments.set(containerName, runnerOptions.environment ?? {})
      return completed()
    }

    if (
      argumentsList[0] === 'image'
      && argumentsList[1] === 'inspect'
      && argumentsList.at(-1) === '{{json .RepoDigests}}'
    ) {
      const reference = argumentsList[2]
      const digest = reference.slice(reference.lastIndexOf('@') + 1)
      return completed(JSON.stringify([`verified/image@${digest}`]))
    }

    if (argumentsList[0] === 'build') {
      const iidIndex = argumentsList.indexOf('--iidfile')
      const iidName = path.basename(argumentsList[iidIndex + 1])
      const imageName = iidName.startsWith('coturn.')
        ? 'coturn'
        : iidName.startsWith('node-base.')
        ? 'node-base'
        : 'application'
      writeFileSync(argumentsList[iidIndex + 1], syntheticImageId(imageName))
      return completed()
    }

    if (
      argumentsList[0] === 'image'
      && argumentsList[1] === 'inspect'
      && argumentsList.at(-1) === '{{.Id}}'
    ) {
      const reference = argumentsList[2]
      const imageId = options.coturnLocalImageMismatch === true
        && reference === syntheticImageId('coturn')
        ? syntheticImageId('wrong-local-coturn')
        : reference.startsWith('sha256:')
        ? reference
        : syntheticImageId(reference)
      return completed(`${imageId}\n`)
    }

    if (argumentsList[0] === 'image' && argumentsList[1] === 'save') {
      const outputIndex = argumentsList.indexOf('--output')
      const archivePath = argumentsList[outputIndex + 1]
      archiveImageIds.set(
        archivePath,
        writeSyntheticDockerArchive(archivePath, argumentsList.at(-1)),
      )
      return completed()
    }

    if (argumentsList[0] === 'volume') {
      if (
        options.cacheCleanupFailure === true
        && argumentsList[1] === 'rm'
      ) {
        return completed('', 1)
      }
      return completed()
    }

    if (argumentsList[0] === 'container' && argumentsList[1] === 'rm') {
      const identifier = argumentsList.at(-1)
      const entry = [...activeContainers.entries()].find(([name, id]) => (
        name === identifier || id === identifier
      ))
      if (options.containerCleanupFailure === true) return completed('', 1)
      if (!entry) return completed('', 1)
      activeContainers.delete(entry[0])
      return completed()
    }

    if (argumentsList[0] === 'container' && argumentsList[1] === 'inspect') {
      const identifier = argumentsList[2]
      if (identifier === 'ediz-remote' || identifier === 'ediz-remote-coturn') {
        const environment = deployedEnvironments.get(identifier) ?? {}
        const expectedImage = identifier === 'ediz-remote'
          ? environment.EDIZ_REMOTE_APP_IMAGE
          : environment.EDIZ_REMOTE_COTURN_IMAGE
        const image = options.deployedImageMismatch === identifier
          ? syntheticImageId(`wrong-${identifier}`)
          : expectedImage
        return completed([
          image,
          environment.EDIZ_REMOTE_DEPLOYMENT_VALIDATED,
          expectedImage,
          'true',
          'healthy',
        ].join('|'))
      }
      const exists = [...activeContainers.entries()].some(([name, id]) => (
        name === identifier || id === identifier
      ))
      return completed('', exists ? 0 : 1)
    }

    if (argumentsList[0] === 'run') {
      const name = argumentsList[argumentsList.indexOf('--name') + 1]
      const cidFile = argumentsList[argumentsList.indexOf('--cidfile') + 1]
      const containerId = createHash('sha256').update(name).digest('hex')
      assert.match(name, /^ediz-remote-security-audit-[0-9a-f-]+$/u)
      writeFileSync(cidFile, `${containerId}\n`)
      if (
        options.containerCleanupFailure === true
        || options.scannerTimeout === true
      ) {
        activeContainers.set(name, containerId)
      }
      if (options.scannerTimeout === true) return completed('', null)
      if (argumentsList.includes('--download-db-only')) return completed()
      if (argumentsList.includes('version')) {
        const currentTimestamp = new Date().toISOString()
        return completed(JSON.stringify({
          Version: '0.74.0',
          VulnerabilityDB: {
            DownloadedAt: currentTimestamp,
            UpdatedAt: currentTimestamp,
            Version: 2,
          },
        }))
      }

      const formatIndex = argumentsList.indexOf('--format')
      const format = argumentsList[formatIndex + 1]
      const archiveMount = argumentsList.find((item) => (
        item.includes('target=/input/image.tar')
      ))
      const archivePath = /^type=bind,source=(.*),target=\/input\/image\.tar,readonly$/u
        .exec(archiveMount)?.[1]
      const targetName = /(?:^|[\\/])(node-base|application|coturn)\.tar$/u
        .exec(archivePath)?.[1]
      const expectedImageId = archiveImageIds.get(archivePath)
      assert.ok(targetName)
      assert.match(expectedImageId, /^sha256:[a-f0-9]{64}$/u)

      if (format === 'cyclonedx') {
        const imageIdProperties = options.missingCycloneBinding === true
          ? []
          : [{
            name: 'aquasecurity:trivy:ImageID',
            value: expectedImageId,
          }]
        if (options.duplicateCycloneBinding === true) {
          imageIdProperties.push({
            name: 'aquasecurity:trivy:ImageID',
            value: expectedImageId,
          })
        }
        return completed(JSON.stringify({
          bomFormat: 'CycloneDX',
          components: options.emptySbom === true
            ? []
            : [{ name: 'synthetic-package', type: 'library', version: '1.0.0' }],
          metadata: {
            component: {
              name: 'synthetic-image',
              properties: imageIdProperties,
              type: 'container',
            },
          },
          serialNumber: 'urn:uuid:12345678-1234-1234-1234-123456789abc',
          specVersion: '1.6',
        }))
      }
      if (format === 'spdx-json') {
        const imageIdAnnotations = options.missingSpdxBinding === true
          ? []
          : [{
            annotationDate: '2026-09-02T00:00:00Z',
            annotationType: 'OTHER',
            annotator: 'Tool: Trivy-0.74.0',
            comment: `ImageID: ${options.wrongSpdxBinding === true
              ? syntheticImageId('wrong-spdx-image')
              : expectedImageId}`,
          }]
        if (options.duplicateSpdxBinding === true) {
          imageIdAnnotations.push({
            annotationDate: '2026-09-02T00:00:00Z',
            annotationType: 'OTHER',
            annotator: 'Tool: Trivy-0.74.0',
            comment: `ImageID: ${expectedImageId}`,
          })
        }
        return completed(JSON.stringify({
          SPDXID: 'SPDXRef-DOCUMENT',
          creationInfo: { creators: ['Tool: Trivy-0.74.0'] },
          dataLicense: 'CC0-1.0',
          documentNamespace: 'https://example.invalid/synthetic-spdx',
          name: 'synthetic-image',
          packages: options.emptySbom === true
            ? []
            : [{
              annotations: imageIdAnnotations,
              name: 'synthetic-package',
              primaryPackagePurpose: 'CONTAINER',
              SPDXID: 'SPDXRef-Package',
            }],
          spdxVersion: 'SPDX-2.3',
        }))
      }
      if (format === 'json') {
        const findingCount = options.findingsByTarget?.[targetName] ?? 0
        const vulnerabilities = Array.from(
          { length: findingCount },
          () => ({ Severity: 'HIGH' }),
        )
        const result = completed(
          JSON.stringify({
            ArtifactName: '/input/image.tar',
            ArtifactType: 'container_image',
            Metadata: {
              ImageID: options.wrongImageBinding === true
                ? syntheticImageId('wrong-image')
                : expectedImageId,
            },
            Results: [{ Target: 'synthetic-target', Vulnerabilities: vulnerabilities }],
            SchemaVersion: 2,
          }),
          findingCount > 0 ? 17 : 0,
        )
        if (
          options.mutateArchiveAfterScan === true
          && !mutatedArchives.has(archivePath)
        ) {
          appendFileSync(archivePath, ':mutated-after-scan')
          mutatedArchives.add(archivePath)
        }
        return result
      }
    }

    assert.fail(`Unexpected synthetic Docker command: ${argumentsList[0]}`)
  }
  return { callOptions, calls, runner }
}

test('deployment images and scanner use exact multi-platform digest locks', () => {
  assert.equal(loadPinnedImageConfiguration(REPOSITORY_ROOT), IMAGE_LOCKS)
  const productionCompose = readFileSync(
    path.join(REPOSITORY_ROOT, 'docker-compose.yml'),
    'utf8',
  )
  const developmentCompose = readFileSync(
    path.join(REPOSITORY_ROOT, 'docker-compose.dev.yml'),
    'utf8',
  )
  assert.equal(/^[ \t]*build[ \t]*:/mu.test(productionCompose), false)
  assert.match(productionCompose, /\$\{EDIZ_REMOTE_APP_IMAGE:\?/u)
  assert.match(productionCompose, /org\.ediz-remote\.security-audit-image:/u)
  assert.match(productionCompose, /^[ \t]*pull_policy:[ \t]*never[ \t]*$/mu)
  assert.match(productionCompose, /^[ \t]*read_only:[ \t]*true[ \t]*$/mu)
  assert.match(productionCompose, /^[ \t]*pids_limit:[ \t]*256[ \t]*$/mu)
  assert.match(productionCompose, /^[ \t]*-[ \t]*ALL[ \t]*$/mu)
  assert.match(productionCompose, /no-new-privileges:true/u)
  assert.match(productionCompose, /\/tmp:size=64m,mode=0700,uid=1000,gid=1000,noexec,nosuid,nodev/u)
  assert.match(developmentCompose, /^[ \t]*build:[ \t]*\.[ \t]*$/mu)
  const coturnCompose = readFileSync(
    path.join(REPOSITORY_ROOT, 'infra', 'coturn', 'compose.yml'),
    'utf8',
  )
  const coturnDockerfile = readFileSync(
    path.join(REPOSITORY_ROOT, 'infra', 'coturn', 'Dockerfile'),
    'utf8',
  )
  assert.match(coturnCompose, /\$\{EDIZ_REMOTE_COTURN_IMAGE:\?/u)
  assert.match(coturnCompose, /^[ \t]*pull_policy:[ \t]*never[ \t]*$/mu)
  assert.match(coturnCompose, /org\.ediz-remote\.security-audit:/u)
  assert.match(coturnCompose, /org\.ediz-remote\.security-audit-image:/u)
  assert.doesNotMatch(coturnCompose, /entrypoint\.sh:/u)
  assert.match(coturnDockerfile, new RegExp(`FROM ${IMAGE_LOCKS.coturn.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
  assert.match(coturnDockerfile, /COPY --chmod=0555 entrypoint\.sh/u)
  for (const [name, reference] of Object.entries(IMAGE_LOCKS)) {
    const parsed = parsePinnedImageReference(reference)
    assert.match(parsed.digest, /^sha256:[a-f0-9]{64}$/u)
    assert.deepEqual(
      IMAGE_LOCK_METADATA[name].platforms,
      ['linux/amd64', 'linux/arm64'],
    )
  }
  assert.throws(
    () => parsePinnedImageReference('node:22-bookworm-slim'),
    (error) => (
      error instanceof ContainerSecurityAuditError
      && error.code === 'configuration_invalid'
    ),
  )
})

test('rejects dockerignore re-includes after required secret exclusions', (t) => {
  const repositoryRoot = temporaryRepositoryRoot(t)
  appendFileSync(
    path.join(repositoryRoot, '.dockerignore'),
    '\n!secrets/reincluded.key\n',
  )
  assert.throws(
    () => loadPinnedImageConfiguration(repositoryRoot),
    (error) => error.code === 'configuration_invalid',
  )
})

test('coturn runtime context is restricted to its pinned Dockerfile and entrypoint', (t) => {
  const repositoryRoot = temporaryRepositoryRoot(t)
  appendFileSync(
    path.join(repositoryRoot, 'infra', 'coturn', '.dockerignore'),
    '!compose.yml\n',
  )
  assert.throws(
    () => loadPinnedImageConfiguration(repositoryRoot),
    (error) => error.code === 'configuration_invalid',
  )

  copyFileSync(
    path.join(REPOSITORY_ROOT, 'infra', 'coturn', '.dockerignore'),
    path.join(repositoryRoot, 'infra', 'coturn', '.dockerignore'),
  )
  appendFileSync(
    path.join(repositoryRoot, 'infra', 'coturn', 'Dockerfile'),
    'RUN echo unexpected\n',
  )
  assert.throws(
    () => loadPinnedImageConfiguration(repositoryRoot),
    (error) => error.code === 'configuration_invalid',
  )
})

test('rejects repository configuration through a directory reparse point', (t) => {
  const repositoryRoot = temporaryRepositoryRoot(t)
  const externalRoot = temporaryOutputDirectory(t)
  mkdirSync(path.join(externalRoot, 'coturn'))
  copyFileSync(
    path.join(REPOSITORY_ROOT, 'infra', 'coturn', 'compose.yml'),
    path.join(externalRoot, 'coturn', 'compose.yml'),
  )
  rmSync(path.join(repositoryRoot, 'infra'), { recursive: true, force: true })
  const link = path.join(repositoryRoot, 'infra')
  if (!createDirectoryLink(t, externalRoot, link)) return
  try {
    assert.throws(
      () => loadPinnedImageConfiguration(repositoryRoot),
      (error) => error.code === 'path_unsafe',
    )
  } finally {
    unlinkSync(link)
  }
})

test('does not delete through a reparse-point output parent', (t) => {
  const linkRoot = temporaryOutputDirectory(t)
  const externalRoot = temporaryOutputDirectory(t)
  const externalOutput = path.join(externalRoot, 'nested')
  mkdirSync(externalOutput)
  writeFileSync(path.join(externalOutput, 'deployment.env'), 'external-reference')
  const link = path.join(linkRoot, 'outside')
  if (!createDirectoryLink(t, externalRoot, link)) return
  const { calls, runner } = createFakeRunner()
  try {
    assert.throws(
      () => runContainerSecurityAudit({
        log: () => {},
        outputDirectory: path.join(link, 'nested'),
        repositoryRoot: REPOSITORY_ROOT,
        runner,
      }),
      (error) => error.code === 'path_unsafe',
    )
    assert.equal(
      readFileSync(path.join(externalOutput, 'deployment.env'), 'utf8'),
      'external-reference',
    )
    assert.equal(calls.length, 0)
  } finally {
    unlinkSync(link)
  }
})

test('rejects a reparse-point audit lock without touching its target', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const externalRoot = temporaryOutputDirectory(t)
  writeFileSync(path.join(externalRoot, 'sentinel'), 'untouched')
  const link = path.join(outputDirectory, '.container-audit.lock')
  if (!createDirectoryLink(t, externalRoot, link)) return
  try {
    assert.throws(
      () => runContainerSecurityAudit({
        log: () => {},
        outputDirectory,
        repositoryRoot: REPOSITORY_ROOT,
        runner: createFakeRunner().runner,
      }),
      (error) => error.code === 'path_unsafe',
    )
    assert.equal(readFileSync(path.join(externalRoot, 'sentinel'), 'utf8'), 'untouched')
  } finally {
    unlinkSync(link)
  }
})

test('creates image-bound SBOM evidence and an immutable deployment reference', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const { calls, runner } = createFakeRunner()
  const logs = []

  const result = runContainerSecurityAudit({
    log: (message) => logs.push(message),
    outputDirectory,
    repositoryRoot: REPOSITORY_ROOT,
    runner,
  })

  assert.equal(calls.some((argumentsList) => argumentsList[0] === 'manifest'), false)

  assert.equal(result.artifactNames.length, 11)
  assert.deepEqual(readdirSync(outputDirectory).sort(), [...result.artifactNames].sort())
  const manifest = JSON.parse(readFileSync(
    path.join(outputDirectory, 'container-audit-manifest.json'),
    'utf8',
  ))
  assert.equal(manifest.gatePassed, true)
  assert.equal(manifest.schemaVersion, 3)
  assert.equal(manifest.platform, 'linux/amd64')
  assert.equal(manifest.applicationImage, result.applicationImage)
  assert.equal(manifest.coturnBaseImage, IMAGE_LOCKS.coturn)
  assert.equal(manifest.coturnImage, result.coturnImage)
  assert.equal(manifest.targets.length, 3)
  assert.equal(manifest.targets.every((target) => target.reports.length === 3), true)
  const coturnTarget = manifest.targets.find((target) => target.target === 'coturn')
  assert.equal(coturnTarget.imageId, result.coturnImage)
  assert.match(coturnTarget.imageConfigDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.notEqual(coturnTarget.imageConfigDigest, coturnTarget.imageId)
  assert.equal(coturnTarget.sourceReference, result.coturnImage)
  assert.equal(
    readFileSync(path.join(outputDirectory, 'deployment.env'), 'utf8'),
    [
      `EDIZ_REMOTE_APP_IMAGE=${result.applicationImage}`,
      `EDIZ_REMOTE_COTURN_IMAGE=${result.coturnImage}`,
      `EDIZ_REMOTE_AUDIT_MANIFEST_SHA256=${createHash('sha256')
        .update(readFileSync(
          path.join(outputDirectory, 'container-audit-manifest.json'),
          'utf8',
        ))
        .digest('hex')}`,
      '',
    ].join('\n'),
  )

  const scannerCalls = calls.filter((argumentsList) => (
    argumentsList[0] === 'run' && argumentsList.includes('/input/image.tar')
  ))
  assert.equal(scannerCalls.length, 9)
  for (const argumentsList of scannerCalls) {
    assert.ok(argumentsList.includes(IMAGE_LOCKS.scanner))
    assert.ok(argumentsList.includes('--offline-scan'))
    assert.ok(argumentsList.includes('--skip-db-update'))
    assert.ok(argumentsList.includes('--read-only'))
    assert.ok(argumentsList.includes('--rm'))
    assert.deepEqual(
      argumentsList.slice(argumentsList.indexOf('--log-driver'), argumentsList.indexOf('--log-driver') + 2),
      ['--log-driver', 'none'],
    )
    assert.deepEqual(
      argumentsList.slice(argumentsList.indexOf('--cpus'), argumentsList.indexOf('--cpus') + 2),
      ['--cpus', '2'],
    )
    assert.deepEqual(
      argumentsList.slice(argumentsList.indexOf('--memory'), argumentsList.indexOf('--memory') + 2),
      ['--memory', '2g'],
    )
    assert.deepEqual(
      argumentsList.slice(argumentsList.indexOf('--pids-limit'), argumentsList.indexOf('--pids-limit') + 2),
      ['--pids-limit', '256'],
    )
    assert.match(argumentsList[argumentsList.indexOf('--name') + 1], /^ediz-remote-security-audit-/u)
    assert.match(path.basename(argumentsList[argumentsList.indexOf('--cidfile') + 1]), /^\.scanner-/u)
    assert.deepEqual(
      argumentsList.slice(argumentsList.indexOf('--network'), argumentsList.indexOf('--network') + 2),
      ['--network', 'none'],
    )
    assert.deepEqual(
      argumentsList.slice(argumentsList.indexOf('--ignorefile'), argumentsList.indexOf('--ignorefile') + 2),
      ['--ignorefile', '/dev/null'],
    )
    assert.deepEqual(
      argumentsList.slice(argumentsList.indexOf('--scanners'), argumentsList.indexOf('--scanners') + 2),
      ['--scanners', 'vuln'],
    )
    assert.equal(argumentsList.some((item) => item.includes('docker.sock')), false)
    assert.equal(argumentsList.some((item) => item.includes(REPOSITORY_ROOT)), false)
  }
  const buildCalls = calls.filter((argumentsList) => argumentsList[0] === 'build')
  assert.equal(buildCalls.length, 3)
  for (const buildCall of buildCalls) {
    assert.ok(buildCall.includes('--iidfile'))
    assert.equal(buildCall.includes('--tag'), false)
  }
  // Build context klasör adına değil (CI'da depo farklı yoldadır) tam depo köküne bağlıdır.
  assert.equal(buildCalls[0].at(-1), path.resolve(REPOSITORY_ROOT))
  assert.deepEqual(
    buildCalls[0].slice(buildCalls[0].indexOf('--target'), buildCalls[0].indexOf('--target') + 2),
    ['--target', 'runtime-base'],
  )
  assert.equal(buildCalls[1].at(-1), path.resolve(REPOSITORY_ROOT))
  assert.equal(buildCalls[1].includes('--target'), false)
  assert.equal(buildCalls[2].at(-1), path.resolve(REPOSITORY_ROOT, 'infra', 'coturn'))
  const databaseCall = calls.find((argumentsList) => (
    argumentsList[0] === 'run' && argumentsList.includes('--download-db-only')
  ))
  assert.ok(databaseCall.includes('--read-only'))
  assert.deepEqual(
    databaseCall.slice(databaseCall.indexOf('--network'), databaseCall.indexOf('--network') + 2),
    ['--network', 'bridge'],
  )
  const volumeCreate = calls.find((argumentsList) => (
    argumentsList[0] === 'volume' && argumentsList[1] === 'create'
  ))
  const volumeRemove = calls.find((argumentsList) => (
    argumentsList[0] === 'volume' && argumentsList[1] === 'rm'
  ))
  assert.match(volumeCreate.at(-1), /^ediz-remote-trivy-[0-9a-f-]+$/u)
  assert.equal(volumeRemove.at(-1), volumeCreate.at(-1))
  const trivyRuns = calls.filter((argumentsList) => (
    argumentsList[0] === 'run' && argumentsList.includes(IMAGE_LOCKS.scanner)
  ))
  const containerRemovals = calls.filter((argumentsList) => (
    argumentsList[0] === 'container' && argumentsList[1] === 'rm'
  ))
  assert.equal(trivyRuns.length, 11)
  assert.equal(containerRemovals.length >= trivyRuns.length, true)
  assert.ok(logs.includes('container_security_audit:passed'))
  assert.equal(logs.join('\n').includes(SENTINEL_SECRET), false)
})

test('fails closed with a fixed code when the pinned scanner is unavailable', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  writeFileSync(path.join(outputDirectory, 'deployment.env'), 'stale-reference')
  const { runner } = createFakeRunner({ scannerUnavailable: true })
  const logs = []

  assert.throws(
    () => runContainerSecurityAudit({
      log: (message) => logs.push(message),
      outputDirectory,
      repositoryRoot: REPOSITORY_ROOT,
      runner,
    }),
    (error) => (
      error instanceof ContainerSecurityAuditError
      && error.code === 'scanner_unavailable'
      && !error.message.includes(SENTINEL_SECRET)
    ),
  )
  assert.equal(logs.join('\n').includes(SENTINEL_SECRET), false)
  assert.equal(logs.includes('container_security_audit:passed'), false)
  assert.equal(existsSync(path.join(outputDirectory, 'deployment.env')), false)
})

test('removes a stale deployment reference before configuration validation fails', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const repositoryRoot = temporaryRepositoryRoot(t)
  writeFileSync(path.join(outputDirectory, 'deployment.env'), 'stale-reference')
  writeFileSync(path.join(repositoryRoot, 'Dockerfile'), 'FROM node:latest\n')
  const { calls, runner } = createFakeRunner()

  assert.throws(
    () => runContainerSecurityAudit({
      log: () => {},
      outputDirectory,
      repositoryRoot,
      runner,
    }),
    (error) => error.code === 'configuration_invalid',
  )
  assert.equal(calls.length, 0)
  assert.equal(existsSync(path.join(outputDirectory, 'deployment.env')), false)
})

test('rejects a remote Docker daemon before exporting an image', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  writeFileSync(path.join(outputDirectory, 'deployment.env'), 'stale-reference')
  const { calls, runner } = createFakeRunner({
    contextHost: 'ssh://builder.example.test',
  })
  assert.throws(
    () => runContainerSecurityAudit({
      log: () => {},
      outputDirectory,
      repositoryRoot: REPOSITORY_ROOT,
      runner,
    }),
    (error) => error.code === 'docker_context_invalid',
  )
  assert.equal(calls.some((argumentsList) => argumentsList[0] === 'pull'), false)
  assert.equal(existsSync(path.join(outputDirectory, 'deployment.env')), false)
})

test('does not publish a deployment reference when final cleanup fails', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const { runner } = createFakeRunner({ cacheCleanupFailure: true })
  assert.throws(
    () => runContainerSecurityAudit({
      log: () => {},
      outputDirectory,
      repositoryRoot: REPOSITORY_ROOT,
      runner,
    }),
    (error) => error.code === 'scanner_cache_failed',
  )
  assert.equal(existsSync(path.join(outputDirectory, 'deployment.env')), false)
  assert.equal(
    existsSync(path.join(outputDirectory, 'container-audit-manifest.json')),
    false,
  )
})

test('removes a timed-out scanner by deterministic container identity', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const { calls, runner } = createFakeRunner({ scannerTimeout: true })
  assert.throws(
    () => runContainerSecurityAudit({
      log: () => {},
      outputDirectory,
      repositoryRoot: REPOSITORY_ROOT,
      runner,
    }),
    (error) => error.code === 'scanner_database_failed',
  )
  assert.equal(calls.some((argumentsList) => (
    argumentsList[0] === 'container'
    && argumentsList[1] === 'rm'
    && argumentsList.includes('--force')
  )), true)
  assert.equal(existsSync(path.join(outputDirectory, 'deployment.env')), false)
})

test('fails closed when a scanner container cannot be proven removed', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const { runner } = createFakeRunner({ containerCleanupFailure: true })
  assert.throws(
    () => runContainerSecurityAudit({
      log: () => {},
      outputDirectory,
      repositoryRoot: REPOSITORY_ROOT,
      runner,
    }),
    (error) => error.code === 'scanner_container_cleanup_failed',
  )
  assert.equal(existsSync(path.join(outputDirectory, 'deployment.env')), false)
})

test('rejects an image archive changed after scanner use', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const { runner } = createFakeRunner({ mutateArchiveAfterScan: true })
  assert.throws(
    () => runContainerSecurityAudit({
      log: () => {},
      outputDirectory,
      repositoryRoot: REPOSITORY_ROOT,
      runner,
    }),
    (error) => error.code === 'image_archive_changed',
  )
  assert.equal(existsSync(path.join(outputDirectory, 'deployment.env')), false)
})

test('rejects empty SBOMs and vulnerability reports bound to another image', (t) => {
  const emptyOutput = temporaryOutputDirectory(t)
  const emptyRunner = createFakeRunner({ emptySbom: true }).runner
  assert.throws(
    () => runContainerSecurityAudit({
      log: () => {},
      outputDirectory: emptyOutput,
      repositoryRoot: REPOSITORY_ROOT,
      runner: emptyRunner,
    }),
    (error) => error.code === 'sbom_invalid',
  )

  const wrongOutput = temporaryOutputDirectory(t)
  const wrongRunner = createFakeRunner({ wrongImageBinding: true }).runner
  assert.throws(
    () => runContainerSecurityAudit({
      log: () => {},
      outputDirectory: wrongOutput,
      repositoryRoot: REPOSITORY_ROOT,
      runner: wrongRunner,
    }),
    (error) => error.code === 'vulnerability_report_invalid',
  )

  const wrongSpdxOutput = temporaryOutputDirectory(t)
  const wrongSpdxRunner = createFakeRunner({ wrongSpdxBinding: true }).runner
  assert.throws(
    () => runContainerSecurityAudit({
      log: () => {},
      outputDirectory: wrongSpdxOutput,
      repositoryRoot: REPOSITORY_ROOT,
      runner: wrongSpdxRunner,
    }),
    (error) => error.code === 'sbom_invalid',
  )
})

test('rejects missing or duplicate native image bindings in both SBOM formats', (t) => {
  for (const optionName of [
    'missingCycloneBinding',
    'duplicateCycloneBinding',
    'missingSpdxBinding',
    'duplicateSpdxBinding',
  ]) {
    const outputDirectory = temporaryOutputDirectory(t)
    const { runner } = createFakeRunner({ [optionName]: true })
    assert.throws(
      () => runContainerSecurityAudit({
        log: () => {},
        outputDirectory,
        repositoryRoot: REPOSITORY_ROOT,
        runner,
      }),
      (error) => error.code === 'sbom_invalid',
      optionName,
    )
  }
})

test('writes complete evidence but no deploy reference when findings fail the gate', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const { runner } = createFakeRunner({
    findingsByTarget: { coturn: 2 },
  })
  const logs = []

  assert.throws(
    () => runContainerSecurityAudit({
      log: (message) => logs.push(message),
      outputDirectory,
      repositoryRoot: REPOSITORY_ROOT,
      runner,
    }),
    (error) => (
      error instanceof ContainerSecurityAuditError
      && error.code === 'high_critical_findings'
    ),
  )
  const outputNames = readdirSync(outputDirectory)
  assert.equal(outputNames.includes('deployment.env'), false)
  assert.equal(outputNames.length, 10)
  const manifest = JSON.parse(readFileSync(
    path.join(outputDirectory, 'container-audit-manifest.json'),
    'utf8',
  ))
  assert.equal(manifest.gatePassed, false)
  assert.equal(logs.includes('container_security_audit:target_scanned:coturn'), true)
  assert.equal(logs.includes('container_security_audit:passed'), false)
})

test('deploy consumer verifies the unlocked manifest commit before compose', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const repositoryRoot = temporaryRepositoryRoot(t)
  writeFileSync(path.join(repositoryRoot, '.env'), 'TURN_SHARED_SECRET=synthetic\n')
  const { callOptions, calls, runner } = createFakeRunner()
  runContainerSecurityAudit({
    log: () => {},
    outputDirectory,
    repositoryRoot,
    runner,
  })

  const logs = []
  runContainerDeployment({
    log: (message) => logs.push(message),
    outputDirectory,
    repositoryRoot,
    runner,
  })
  const composeIndexes = calls
    .map((argumentsList, index) => argumentsList[0] === 'compose' ? index : -1)
    .filter((index) => index >= 0)
  assert.equal(composeIndexes.length, 2)
  for (const composeIndex of composeIndexes) {
    assert.ok(calls[composeIndex].includes('--no-build'))
    assert.deepEqual(
      calls[composeIndex].slice(calls[composeIndex].indexOf('--pull'), calls[composeIndex].indexOf('--pull') + 2),
      ['--pull', 'never'],
    )
    assert.ok(calls[composeIndex].includes('--wait'))
    assert.deepEqual(
      calls[composeIndex].slice(calls[composeIndex].indexOf('--wait-timeout'), calls[composeIndex].indexOf('--wait-timeout') + 2),
      ['--wait-timeout', '120'],
    )
  }
  assert.match(calls[composeIndexes[0]][calls[composeIndexes[0]].indexOf('--file') + 1], /docker-compose\.yml$/u)
  assert.match(calls[composeIndexes[1]][calls[composeIndexes[1]].indexOf('--file') + 1], /infra[\\/]coturn[\\/]compose\.yml$/u)
  const deploymentEnvironment = readFileSync(
    path.join(outputDirectory, 'deployment.env'),
    'utf8',
  )
  const commit = /EDIZ_REMOTE_AUDIT_MANIFEST_SHA256=([a-f0-9]{64})/u
    .exec(deploymentEnvironment)?.[1]
  assert.equal(
    callOptions[composeIndexes[0]].environment.EDIZ_REMOTE_DEPLOYMENT_VALIDATED,
    commit,
  )
  assert.equal(
    callOptions[composeIndexes[1]].environment.EDIZ_REMOTE_DEPLOYMENT_VALIDATED,
    commit,
  )
  assert.match(
    callOptions[composeIndexes[1]].environment.EDIZ_REMOTE_COTURN_IMAGE,
    /^sha256:[a-f0-9]{64}$/u,
  )
  const deployedInspections = calls.filter((argumentsList) => (
    argumentsList[0] === 'container'
    && argumentsList[1] === 'inspect'
    && ['ediz-remote', 'ediz-remote-coturn'].includes(argumentsList[2])
  ))
  assert.equal(deployedInspections.length, 2)
  assert.deepEqual(logs, ['container_deployment:passed'])
})

test('deploy consumer rejects stale or future-dated scanner database evidence', (t) => {
  for (const [label, timestamp] of [
    ['stale', new Date(Date.now() - 49 * 60 * 60 * 1_000).toISOString()],
    ['future', new Date(Date.now() + 6 * 60 * 1_000).toISOString()],
  ]) {
    const outputDirectory = temporaryOutputDirectory(t)
    const repositoryRoot = temporaryRepositoryRoot(t)
    writeFileSync(path.join(repositoryRoot, '.env'), 'TURN_SHARED_SECRET=synthetic\n')
    const audit = createFakeRunner()
    runContainerSecurityAudit({
      log: () => {},
      outputDirectory,
      repositoryRoot,
      runner: audit.runner,
    })
    rewriteDeploymentManifest(outputDirectory, (manifest) => {
      manifest.database.updatedAt = timestamp
      manifest.database.downloadedAt = timestamp
    })
    const deployment = createFakeRunner()
    assert.throws(
      () => runContainerDeployment({
        log: () => {},
        outputDirectory,
        repositoryRoot,
        runner: deployment.runner,
      }),
      (error) => error.code === 'deployment_invalid',
      label,
    )
    assert.equal(
      deployment.calls.some((argumentsList) => argumentsList[0] === 'compose'),
      false,
      label,
    )
  }
})

test('deploy consumer binds coturn source, local image and running container', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const repositoryRoot = temporaryRepositoryRoot(t)
  writeFileSync(path.join(repositoryRoot, '.env'), 'TURN_SHARED_SECRET=synthetic\n')
  const audit = createFakeRunner()
  runContainerSecurityAudit({
    log: () => {},
    outputDirectory,
    repositoryRoot,
    runner: audit.runner,
  })

  rewriteDeploymentManifest(outputDirectory, (manifest) => {
    manifest.targets.find((target) => target.target === 'coturn').sourceReference = IMAGE_LOCKS.node
  })
  const wrongSource = createFakeRunner()
  assert.throws(
    () => runContainerDeployment({
      log: () => {},
      outputDirectory,
      repositoryRoot,
      runner: wrongSource.runner,
    }),
    (error) => error.code === 'deployment_invalid',
  )
  assert.equal(wrongSource.calls.some((argumentsList) => argumentsList[0] === 'compose'), false)

  const cleanAudit = createFakeRunner()
  runContainerSecurityAudit({
    log: () => {},
    outputDirectory,
    repositoryRoot,
    runner: cleanAudit.runner,
  })
  const wrongLocalImage = createFakeRunner({ coturnLocalImageMismatch: true })
  assert.throws(
    () => runContainerDeployment({
      log: () => {},
      outputDirectory,
      repositoryRoot,
      runner: wrongLocalImage.runner,
    }),
    (error) => error.code === 'deployment_invalid',
  )
  assert.equal(
    wrongLocalImage.calls.some((argumentsList) => argumentsList[0] === 'compose'),
    false,
  )

  const wrongContainer = createFakeRunner({
    deployedImageMismatch: 'ediz-remote-coturn',
  })
  assert.throws(
    () => runContainerDeployment({
      log: () => {},
      outputDirectory,
      repositoryRoot,
      runner: wrongContainer.runner,
    }),
    (error) => error.code === 'deployment_failed',
  )
})

test('deployment failure never reports success or automatically tears containers down', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const repositoryRoot = temporaryRepositoryRoot(t)
  writeFileSync(path.join(repositoryRoot, '.env'), 'TURN_SHARED_SECRET=synthetic\n')
  const audit = createFakeRunner()
  runContainerSecurityAudit({
    log: () => {},
    outputDirectory,
    repositoryRoot,
    runner: audit.runner,
  })
  const deployment = createFakeRunner({ composeFailureIndex: 2 })
  const logs = []
  assert.throws(
    () => runContainerDeployment({
      log: (message) => logs.push(message),
      outputDirectory,
      repositoryRoot,
      runner: deployment.runner,
    }),
    (error) => error.code === 'deployment_failed',
  )
  assert.equal(
    deployment.calls.filter((argumentsList) => argumentsList[0] === 'compose').length,
    2,
  )
  assert.equal(deployment.calls.some((argumentsList) => (
    argumentsList.includes('down')
    || argumentsList.includes('stop')
    || (argumentsList[0] === 'container' && argumentsList[1] === 'rm')
  )), false)
  assert.deepEqual(logs, [])
})

test('deploy consumer rejects a crash-window commit while the audit lock remains', (t) => {
  const outputDirectory = temporaryOutputDirectory(t)
  const repositoryRoot = temporaryRepositoryRoot(t)
  writeFileSync(path.join(repositoryRoot, '.env'), 'TURN_SHARED_SECRET=synthetic\n')
  const first = createFakeRunner()
  runContainerSecurityAudit({
    log: () => {},
    outputDirectory,
    repositoryRoot,
    runner: first.runner,
  })
  writeFileSync(path.join(outputDirectory, '.container-audit.lock'), 'stale-lock\n')
  assert.throws(
    () => runContainerDeployment({
      log: () => {},
      outputDirectory,
      repositoryRoot,
      runner: first.runner,
    }),
    (error) => error.code === 'deployment_locked',
  )
  assert.equal(
    first.calls.some((argumentsList) => argumentsList[0] === 'compose'),
    false,
  )
  rmSync(path.join(outputDirectory, '.container-audit.lock'), { force: true })

  appendFileSync(
    path.join(outputDirectory, 'container-audit-manifest.json'),
    ' ',
  )
  const second = createFakeRunner()
  assert.throws(
    () => runContainerDeployment({
      log: () => {},
      outputDirectory,
      repositoryRoot,
      runner: second.runner,
    }),
    (error) => error.code === 'deployment_invalid',
  )
  assert.equal(
    second.calls.some((argumentsList) => argumentsList[0] === 'compose'),
    false,
  )
})
