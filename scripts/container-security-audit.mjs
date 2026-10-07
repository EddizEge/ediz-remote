import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
const DEFAULT_OUTPUT_DIRECTORY = path.join(
  DEFAULT_REPOSITORY_ROOT,
  'artifacts',
  'security',
  'containers',
)
const TRIVY_FINDINGS_EXIT_CODE = 17
const COMMAND_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024
const MAX_DATABASE_AGE_MS = 48 * 60 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000
const TEMPORARY_DIRECTORY_PREFIX = 'ediz-remote-container-audit-'
const PRODUCTION_IMAGE_EXPRESSION = '${EDIZ_REMOTE_APP_IMAGE:?Run npm run security:containers and use the generated deployment.env}'
const COTURN_IMAGE_EXPRESSION = '${EDIZ_REMOTE_COTURN_IMAGE:?Run npm run security:containers and use the generated deployment.env}'
const DEPLOYMENT_VALIDATION_EXPRESSION = '${EDIZ_REMOTE_DEPLOYMENT_VALIDATED:?Run npm run security:container:deploy}'
const AUDIT_LABEL = 'org.ediz-remote.security-audit'
const AUDIT_IMAGE_LABEL = 'org.ediz-remote.security-audit-image'

const REQUIRED_PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64'])
export const IMAGE_LOCK_METADATA = Object.freeze({
  node: Object.freeze({
    platforms: REQUIRED_PLATFORMS,
    reference: 'node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
  }),
  coturn: Object.freeze({
    platforms: REQUIRED_PLATFORMS,
    reference: 'coturn/coturn:4.17.0-r0-alpine@sha256:8f80ed9d6867319340ca612b9d005aaea2444755aa4ce3dd79ddfb5f31f6e1b5',
  }),
  scanner: Object.freeze({
    platforms: REQUIRED_PLATFORMS,
    reference: 'aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969',
  }),
})
export const IMAGE_LOCKS = Object.freeze({
  coturn: IMAGE_LOCK_METADATA.coturn.reference,
  node: IMAGE_LOCK_METADATA.node.reference,
  scanner: IMAGE_LOCK_METADATA.scanner.reference,
})

const TARGET_NAMES = Object.freeze(['node-base', 'application', 'coturn'])
const FAILURE_CODES = new Set([
  'audit_already_running',
  'audit_lock_failed',
  'application_build_failed',
  'application_image_invalid',
  'artifact_write_failed',
  'configuration_invalid',
  'docker_cli_unavailable',
  'docker_context_invalid',
  'docker_daemon_unavailable',
  'deployment_failed',
  'deployment_invalid',
  'deployment_locked',
  'coturn_build_failed',
  'coturn_image_invalid',
  'high_critical_findings',
  'image_archive_changed',
  'image_export_failed',
  'image_pull_failed',
  'image_verification_failed',
  'internal_error',
  'linux_engine_required',
  'node_base_build_failed',
  'node_base_image_invalid',
  'path_unsafe',
  'sbom_generation_failed',
  'sbom_invalid',
  'scanner_cache_failed',
  'scanner_container_cleanup_failed',
  'scanner_database_failed',
  'scanner_unavailable',
  'temporary_cleanup_failed',
  'vulnerability_report_invalid',
  'vulnerability_scan_failed',
])

export class ContainerSecurityAuditError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ContainerSecurityAuditError'
    this.code = FAILURE_CODES.has(code) ? code : 'internal_error'
  }
}

function fail(code) {
  throw new ContainerSecurityAuditError(code)
}

export function parsePinnedImageReference(reference) {
  if (typeof reference !== 'string') fail('configuration_invalid')
  const match = /^(?<repository>[a-z0-9][a-z0-9./_-]*):(?<tag>[A-Za-z0-9][A-Za-z0-9._-]*)@(?<digest>sha256:[a-f0-9]{64})$/u.exec(reference)
  if (!match?.groups) fail('configuration_invalid')
  return {
    reference,
    repository: match.groups.repository,
    tag: match.groups.tag,
    digest: match.groups.digest,
  }
}

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function pathsMatch(left, right) {
  return comparablePath(left) === comparablePath(right)
}

function assertPathInside(rootDirectory, candidatePath) {
  const root = path.resolve(rootDirectory)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(root, candidate)
  if (
    relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  ) {
    return candidate
  }
  fail('path_unsafe')
}

function assertSafePathHierarchy(
  targetPath,
  { allowMissing = false, leafType = null } = {},
) {
  const resolved = path.resolve(targetPath)
  const parsed = path.parse(resolved)
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  for (let index = 0; index <= parts.length; index += 1) {
    if (index > 0) current = path.join(current, parts[index - 1])
    let entry
    try {
      entry = lstatSync(current)
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return resolved
      fail('path_unsafe')
    }
    if (entry.isSymbolicLink()) fail('path_unsafe')
    let canonical
    try {
      canonical = realpathSync.native(current)
    } catch {
      fail('path_unsafe')
    }
    if (!pathsMatch(current, canonical)) fail('path_unsafe')
    const isLeaf = index === parts.length
    if (!isLeaf && !entry.isDirectory()) fail('path_unsafe')
    if (isLeaf && leafType === 'directory' && !entry.isDirectory()) fail('path_unsafe')
    if (isLeaf && leafType === 'file' && !entry.isFile()) fail('path_unsafe')
  }
  return resolved
}

function ensureSafeDirectory(directoryPath) {
  const resolved = assertSafePathHierarchy(directoryPath, { allowMissing: true })
  try {
    mkdirSync(resolved, { recursive: true, mode: 0o700 })
  } catch {
    fail('path_unsafe')
  }
  assertSafePathHierarchy(resolved, { leafType: 'directory' })
  return resolved
}

function readTrustedTextFile(
  rootDirectory,
  relativePath,
  maximumBytes = 1024 * 1024,
  failureCode = 'configuration_invalid',
) {
  const root = assertSafePathHierarchy(rootDirectory, { leafType: 'directory' })
  const filePath = assertPathInside(root, path.join(root, relativePath))
  assertSafePathHierarchy(filePath, { leafType: 'file' })
  let descriptor
  try {
    descriptor = openSync(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      fail(failureCode)
    }
    const contents = readFileSync(descriptor, 'utf8')
    const after = fstatSync(descriptor)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      fail(failureCode)
    }
    return contents
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail(failureCode)
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // Configuration parsing will fail independently if the read was incomplete.
      }
    }
  }
}

export function loadPinnedImageConfiguration(repositoryRoot = DEFAULT_REPOSITORY_ROOT) {
  let dockerfile
  let coturnDockerfile
  let coturnDockerignore
  let coturnCompose
  let productionCompose
  let developmentCompose
  let dockerignore
  try {
    dockerfile = readTrustedTextFile(repositoryRoot, 'Dockerfile')
    coturnDockerfile = readTrustedTextFile(
      repositoryRoot,
      path.join('infra', 'coturn', 'Dockerfile'),
    )
    coturnDockerignore = readTrustedTextFile(
      repositoryRoot,
      path.join('infra', 'coturn', '.dockerignore'),
    )
    coturnCompose = readTrustedTextFile(
      repositoryRoot,
      path.join('infra', 'coturn', 'compose.yml'),
    )
    productionCompose = readTrustedTextFile(repositoryRoot, 'docker-compose.yml')
    developmentCompose = readTrustedTextFile(repositoryRoot, 'docker-compose.dev.yml')
    dockerignore = readTrustedTextFile(repositoryRoot, '.dockerignore')
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail('configuration_invalid')
  }

  const nodeReferences = dockerfile
    .split(/\r?\n/u)
    .map((line) => /^FROM\s+(\S+)(?:\s+AS\s+\S+)?\s*$/iu.exec(line)?.[1])
    .filter(Boolean)
  const coturnDockerfileLines = coturnDockerfile
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  const coturnReferences = coturnDockerfileLines
    .map((line) => /^FROM\s+(\S+)\s*$/iu.exec(line)?.[1])
    .filter(Boolean)

  if (
    nodeReferences.length !== 3
    || nodeReferences[0] !== IMAGE_LOCKS.node
    || nodeReferences[1] !== IMAGE_LOCKS.node
    || nodeReferences[2] !== 'runtime-base'
    || coturnReferences.length !== 1
    || coturnReferences[0] !== IMAGE_LOCKS.coturn
    || coturnDockerfileLines.length !== 6
    || coturnDockerfileLines[1] !== 'USER root'
    || coturnDockerfileLines[2]
      !== 'RUN apk upgrade --no-cache && apk add --no-cache libcap && setcap -r /usr/bin/turnserver && apk del libcap'
    || coturnDockerfileLines[3]
      !== 'COPY --chmod=0555 entrypoint.sh /etc/ediz-remote/entrypoint.sh'
    || coturnDockerfileLines[4] !== 'USER 1000:1000'
    || coturnDockerfileLines[5]
      !== 'ENTRYPOINT ["/bin/sh", "/etc/ediz-remote/entrypoint.sh"]'
  ) {
    fail('configuration_invalid')
  }

  const requiredDockerignoreEntries = [
    '.env*',
    '.npmrc',
    '.tools',
    '**/.npmrc',
    '**/*.key',
    '**/*.p12',
    '**/*.pem',
    '**/*.pfx',
    'artifacts',
    'secrets',
  ]
  const dockerignoreLines = dockerignore
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  const dockerignoreEntries = new Set(dockerignoreLines)
  const requiredIgnoreIndexes = requiredDockerignoreEntries.map((entry) => (
    dockerignoreLines.indexOf(entry)
  ))
  const hasRequiredReincludeBypass = dockerignoreLines.some((entry, index) => (
    entry.startsWith('!')
    && requiredIgnoreIndexes.some((requiredIndex) => (
      requiredIndex >= 0 && requiredIndex < index
    ))
  ))
  const productionImageReferences = productionCompose
    .split(/\r?\n/u)
    .map((line) => /^[ \t]*image:[ \t]*(\S(?:.*\S)?)[ \t]*$/u.exec(line)?.[1])
    .filter(Boolean)
  const coturnProductionImageReferences = coturnCompose
    .split(/\r?\n/u)
    .map((line) => /^[ \t]*image:[ \t]*(\S(?:.*\S)?)[ \t]*$/u.exec(line)?.[1])
    .filter(Boolean)
  const coturnDockerignoreLines = coturnDockerignore
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  if (
    requiredDockerignoreEntries.some((entry) => !dockerignoreEntries.has(entry))
    || hasRequiredReincludeBypass
    || /^[ \t]*build[ \t]*:/mu.test(productionCompose)
    || productionImageReferences.length !== 1
    || productionImageReferences[0] !== PRODUCTION_IMAGE_EXPRESSION
    || !/^[ \t]*pull_policy:[ \t]*never[ \t]*$/mu.test(productionCompose)
    || !productionCompose.includes(
      `${AUDIT_LABEL}: ${DEPLOYMENT_VALIDATION_EXPRESSION}`,
    )
    || !productionCompose.includes(
      `${AUDIT_IMAGE_LABEL}: ${PRODUCTION_IMAGE_EXPRESSION}`,
    )
    || !coturnCompose.includes(
      `${AUDIT_LABEL}: ${DEPLOYMENT_VALIDATION_EXPRESSION}`,
    )
    || !coturnCompose.includes(
      `${AUDIT_IMAGE_LABEL}: ${COTURN_IMAGE_EXPRESSION}`,
    )
    || /^[ \t]*build[ \t]*:/mu.test(coturnCompose)
    || coturnProductionImageReferences.length !== 1
    || coturnProductionImageReferences[0] !== COTURN_IMAGE_EXPRESSION
    || !/^[ \t]*pull_policy:[ \t]*never[ \t]*$/mu.test(coturnCompose)
    || /^[ \t]*-[ \t]*[^#\r\n]*entrypoint\.sh[^#\r\n]*\/etc\/ediz-remote\/entrypoint\.sh/mu.test(coturnCompose)
    || coturnDockerignoreLines.length !== 3
    || coturnDockerignoreLines[0] !== '*'
    || coturnDockerignoreLines[1] !== '!Dockerfile'
    || coturnDockerignoreLines[2] !== '!entrypoint.sh'
    || !/^[ \t]*build:[ \t]*\.[ \t]*$/mu.test(developmentCompose)
  ) {
    fail('configuration_invalid')
  }

  parsePinnedImageReference(IMAGE_LOCKS.node)
  parsePinnedImageReference(IMAGE_LOCKS.coturn)
  parsePinnedImageReference(IMAGE_LOCKS.scanner)
  return IMAGE_LOCKS
}

export function createDockerRunner() {
  return (argumentsList, options = {}) => {
    const capture = options.capture === true
    const result = spawnSync('docker', argumentsList, {
      encoding: capture ? 'utf8' : undefined,
      env: options.environment
        ? { ...process.env, ...options.environment }
        : process.env,
      maxBuffer: capture ? MAX_CAPTURE_BYTES : undefined,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })
    return {
      notFound: result.error?.code === 'ENOENT',
      status: Number.isInteger(result.status) ? result.status : null,
      stderr: capture && typeof result.stderr === 'string' ? result.stderr : '',
      stdout: capture && typeof result.stdout === 'string' ? result.stdout : '',
    }
  }
}

function runDocker(runner, argumentsList, options, failureCode) {
  let result
  try {
    result = runner(argumentsList, options)
  } catch {
    fail(failureCode)
  }
  if (!result || result.status !== 0) fail(failureCode)
  return result
}

function assertDockerAvailable(runner) {
  const dockerHost = process.env.DOCKER_HOST
  if (
    typeof dockerHost === 'string'
    && dockerHost.length > 0
    && !/^(?:npipe|unix):\/\//u.test(dockerHost)
  ) {
    fail('docker_context_invalid')
  }

  let result
  try {
    result = runner(
      ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'],
      { capture: true, timeoutMs: 30_000 },
    )
  } catch {
    fail('docker_cli_unavailable')
  }
  if (result?.notFound) fail('docker_cli_unavailable')
  if (result?.status !== 0) fail('docker_daemon_unavailable')
  const enginePlatform = result.stdout.trim()
  if (
    !REQUIRED_PLATFORMS.includes(enginePlatform)
    || Object.values(IMAGE_LOCK_METADATA).some(
      (metadata) => !metadata.platforms.includes(enginePlatform),
    )
  ) {
    fail('linux_engine_required')
  }

  const contextResult = runDocker(
    runner,
    ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
    { capture: true, timeoutMs: 30_000 },
    'docker_context_invalid',
  )
  let contextHost
  try {
    contextHost = JSON.parse(contextResult.stdout)
  } catch {
    fail('docker_context_invalid')
  }
  if (
    typeof contextHost !== 'string'
    || !/^(?:npipe|unix):\/\//u.test(contextHost)
  ) {
    fail('docker_context_invalid')
  }
  return enginePlatform
}

function pullAndVerifyImage(runner, reference, platform, pullFailureCode) {
  runDocker(
    runner,
    ['pull', '--platform', platform, '--quiet', reference],
    { capture: false },
    pullFailureCode,
  )
  const inspectResult = runDocker(
    runner,
    ['image', 'inspect', reference, '--format', '{{json .RepoDigests}}'],
    { capture: true, timeoutMs: 30_000 },
    'image_verification_failed',
  )
  let repositoryDigests
  try {
    repositoryDigests = JSON.parse(inspectResult.stdout)
  } catch {
    fail('image_verification_failed')
  }
  const { digest } = parsePinnedImageReference(reference)
  if (
    !Array.isArray(repositoryDigests)
    || !repositoryDigests.some((item) => (
      typeof item === 'string' && item.endsWith(`@${digest}`)
    ))
  ) {
    fail('image_verification_failed')
  }
  const idResult = runDocker(
    runner,
    ['image', 'inspect', reference, '--format', '{{.Id}}'],
    { capture: true, timeoutMs: 30_000 },
    'image_verification_failed',
  )
  const imageId = idResult.stdout.trim()
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) fail('image_verification_failed')
  return imageId
}

function buildRuntimeImage(
  runner,
  contextDirectory,
  dockerfilePath,
  temporaryDirectory,
  platform,
  imageName,
  buildFailureCode,
  imageFailureCode,
  buildArguments = [],
) {
  const safeTemporaryDirectory = assertSafePathHierarchy(
    temporaryDirectory,
    { leafType: 'directory' },
  )
  const safeContextDirectory = assertSafePathHierarchy(
    contextDirectory,
    { leafType: 'directory' },
  )
  const safeDockerfilePath = assertSafePathHierarchy(
    dockerfilePath,
    { leafType: 'file' },
  )
  const iidFileName = `${imageName}.iid`
  const iidFile = safeArtifactPath(safeTemporaryDirectory, iidFileName)
  if (inspectSafeArtifact(safeTemporaryDirectory, iidFileName).exists) {
    fail(buildFailureCode)
  }
  runDocker(
    runner,
    [
      'build',
      '--pull',
      '--platform',
      platform,
      '--iidfile',
      iidFile,
      '--file',
      safeDockerfilePath,
      ...buildArguments,
      safeContextDirectory,
    ],
    { capture: false },
    buildFailureCode,
  )
  let imageId
  try {
    imageId = readTrustedTextFile(
      safeTemporaryDirectory,
      iidFileName,
      128,
      imageFailureCode,
    ).trim()
    removeSafeArtifact(safeTemporaryDirectory, iidFileName)
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail(imageFailureCode)
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) fail(imageFailureCode)
  const inspectResult = runDocker(
    runner,
    ['image', 'inspect', imageId, '--format', '{{.Id}}'],
    { capture: true, timeoutMs: 30_000 },
    imageFailureCode,
  )
  if (inspectResult.stdout.trim() !== imageId) fail(imageFailureCode)
  return imageId
}

function buildNodeBaseImage(runner, repositoryRoot, temporaryDirectory, platform) {
  return buildRuntimeImage(
    runner,
    repositoryRoot,
    path.join(repositoryRoot, 'Dockerfile'),
    temporaryDirectory,
    platform,
    'node-base',
    'node_base_build_failed',
    'node_base_image_invalid',
    ['--target', 'runtime-base'],
  )
}

function buildApplicationImage(runner, repositoryRoot, temporaryDirectory, platform) {
  return buildRuntimeImage(
    runner,
    repositoryRoot,
    path.join(repositoryRoot, 'Dockerfile'),
    temporaryDirectory,
    platform,
    'application',
    'application_build_failed',
    'application_image_invalid',
  )
}

function buildCoturnImage(runner, repositoryRoot, temporaryDirectory, platform) {
  const contextDirectory = assertPathInside(
    repositoryRoot,
    path.join(repositoryRoot, 'infra', 'coturn'),
  )
  return buildRuntimeImage(
    runner,
    contextDirectory,
    path.join(contextDirectory, 'Dockerfile'),
    temporaryDirectory,
    platform,
    'coturn',
    'coturn_build_failed',
    'coturn_image_invalid',
  )
}

function expectedArtifactNames() {
  return TARGET_NAMES.flatMap((targetName) => [
    `${targetName}.cyclonedx.json`,
    `${targetName}.spdx.json`,
    `${targetName}.vulnerabilities.json`,
  ]).concat(['container-audit-manifest.json', 'deployment.env'])
}

function deploymentOutputDirectories(explicitOutputDirectory) {
  if (explicitOutputDirectory) return [explicitOutputDirectory]
  return REQUIRED_PLATFORMS.map((platform) => (
    path.join(DEFAULT_OUTPUT_DIRECTORY, platform.replace('/', '-'))
  ))
}

function safeDirectoryExists(directoryPath) {
  const resolved = assertSafePathHierarchy(directoryPath, { allowMissing: true })
  try {
    lstatSync(resolved)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    fail('path_unsafe')
  }
  assertSafePathHierarchy(resolved, { leafType: 'directory' })
  return true
}

function safeArtifactPath(outputDirectory, artifactName) {
  if (
    typeof artifactName !== 'string'
    || artifactName.length === 0
    || path.basename(artifactName) !== artifactName
  ) {
    fail('path_unsafe')
  }
  const resolvedDirectory = path.resolve(outputDirectory)
  const artifactPath = assertPathInside(
    resolvedDirectory,
    path.join(resolvedDirectory, artifactName),
  )
  if (!pathsMatch(path.dirname(artifactPath), resolvedDirectory)) fail('path_unsafe')
  return artifactPath
}

function inspectSafeArtifact(outputDirectory, artifactName) {
  if (!safeDirectoryExists(outputDirectory)) {
    return { exists: false, path: safeArtifactPath(outputDirectory, artifactName) }
  }
  const artifactPath = safeArtifactPath(outputDirectory, artifactName)
  try {
    lstatSync(artifactPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, path: artifactPath }
    fail('path_unsafe')
  }
  assertSafePathHierarchy(artifactPath, { leafType: 'file' })
  return { exists: true, path: artifactPath }
}

function removeSafeArtifact(outputDirectory, artifactName) {
  const artifact = inspectSafeArtifact(outputDirectory, artifactName)
  if (!artifact.exists) return
  try {
    rmSync(artifact.path, { force: true })
  } catch {
    fail('artifact_write_failed')
  }
  assertSafePathHierarchy(outputDirectory, { leafType: 'directory' })
}

function invalidateReleaseArtifacts(outputDirectories, includeManifest = false) {
  try {
    for (const outputDirectory of outputDirectories) {
      removeSafeArtifact(outputDirectory, 'deployment.env')
      if (includeManifest) {
        removeSafeArtifact(outputDirectory, 'container-audit-manifest.json')
      }
    }
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail('artifact_write_failed')
  }
}

function acquireAuditLock(outputDirectory, conflictCode = 'audit_already_running') {
  const resolvedDirectory = ensureSafeDirectory(outputDirectory)
  const existingLock = inspectSafeArtifact(
    resolvedDirectory,
    '.container-audit.lock',
  )
  if (existingLock.exists) fail(conflictCode)
  const lockPath = existingLock.path
  let descriptor
  try {
    descriptor = openSync(
      lockPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    const identity = fstatSync(descriptor)
    if (!identity.isFile() || identity.nlink !== 1) fail('audit_lock_failed')
    writeFileSync(descriptor, `${process.pid}\n`, { encoding: 'utf8' })
    fsyncSync(descriptor)
    assertSafePathHierarchy(lockPath, { leafType: 'file' })
    return { descriptor, identity, lockPath, outputDirectory: resolvedDirectory }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // A fixed lock failure is emitted below.
      }
    }
    if (error instanceof ContainerSecurityAuditError) throw error
    if (error?.code === 'EEXIST') fail(conflictCode)
    fail('audit_lock_failed')
  }
}

function releaseAuditLock(lock) {
  let failed = false
  try {
    assertSafePathHierarchy(lock.outputDirectory, { leafType: 'directory' })
    assertSafePathHierarchy(lock.lockPath, { leafType: 'file' })
    const pathIdentity = lstatSync(lock.lockPath)
    const descriptorIdentity = fstatSync(lock.descriptor)
    if (
      !pathIdentity.isFile()
      || !descriptorIdentity.isFile()
      || pathIdentity.nlink !== 1
      || descriptorIdentity.nlink !== 1
      || (
        descriptorIdentity.ino !== 0
        && pathIdentity.ino !== 0
        && (
          descriptorIdentity.dev !== pathIdentity.dev
          || descriptorIdentity.ino !== pathIdentity.ino
        )
      )
    ) {
      failed = true
    }
  } catch {
    failed = true
  }
  try {
    closeSync(lock.descriptor)
  } catch {
    failed = true
  }
  if (!failed) {
    try {
      rmSync(lock.lockPath, { force: true })
      assertSafePathHierarchy(lock.outputDirectory, { leafType: 'directory' })
    } catch {
      failed = true
    }
  }
  if (failed) fail('audit_lock_failed')
}

function prepareOutputDirectory(outputDirectory) {
  try {
    ensureSafeDirectory(outputDirectory)
    for (const artifactName of expectedArtifactNames()) {
      removeSafeArtifact(outputDirectory, artifactName)
    }
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail('artifact_write_failed')
  }
}

function writeArtifact(outputDirectory, artifactName, contents) {
  const resolvedDirectory = ensureSafeDirectory(outputDirectory)
  const destination = inspectSafeArtifact(resolvedDirectory, artifactName)
  if (destination.exists) removeSafeArtifact(resolvedDirectory, artifactName)
  const temporaryName = `.${artifactName}.${process.pid}.${randomUUID()}.tmp`
  const temporary = safeArtifactPath(resolvedDirectory, temporaryName)
  let descriptor
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    const identity = fstatSync(descriptor)
    if (!identity.isFile() || identity.nlink !== 1) fail('artifact_write_failed')
    writeFileSync(descriptor, contents, { encoding: 'utf8' })
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    assertSafePathHierarchy(temporary, { leafType: 'file' })
    assertSafePathHierarchy(resolvedDirectory, { leafType: 'directory' })
    if (inspectSafeArtifact(resolvedDirectory, artifactName).exists) {
      fail('artifact_write_failed')
    }
    renameSync(temporary, destination.path)
    assertSafePathHierarchy(destination.path, { leafType: 'file' })
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // A fixed artifact failure is emitted below.
      }
    }
    try {
      const temporaryArtifact = inspectSafeArtifact(resolvedDirectory, temporaryName)
      if (temporaryArtifact.exists) rmSync(temporaryArtifact.path, { force: true })
    } catch {
      // The public failure remains a fixed code even when cleanup also fails.
    }
    if (error instanceof ContainerSecurityAuditError) throw error
    fail('artifact_write_failed')
  }
  return createHash('sha256').update(contents, 'utf8').digest('hex')
}

function sha256File(filePath, failureCode = 'image_export_failed') {
  const resolvedPath = assertSafePathHierarchy(filePath, { leafType: 'file' })
  let descriptor
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const hash = createHash('sha256')
  try {
    descriptor = openSync(
      resolvedPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size < 1 || before.nlink !== 1) fail(failureCode)
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = fstatSync(descriptor)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.nlink !== 1
    ) {
      fail(failureCode)
    }
    return hash.digest('hex')
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail(failureCode)
  } finally {
    buffer.fill(0)
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // A fixed failure was already selected above if the read did not finish.
      }
    }
  }
}

const TAR_BLOCK_BYTES = 512
const MAX_TAR_ENTRIES = 262_144
const MAX_DOCKER_ARCHIVE_MANIFEST_BYTES = 1024 * 1024
const MAX_DOCKER_IMAGE_CONFIG_BYTES = 16 * 1024 * 1024

function readExactly(descriptor, buffer, position, failureCode) {
  let offset = 0
  while (offset < buffer.length) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    )
    if (bytesRead === 0) fail(failureCode)
    offset += bytesRead
  }
}

function tarTextField(header, start, length) {
  const field = header.subarray(start, start + length)
  const terminator = field.indexOf(0)
  return field
    .subarray(0, terminator === -1 ? field.length : terminator)
    .toString('utf8')
}

function tarOctalField(header, start, length, failureCode) {
  const field = header.subarray(start, start + length)
  if ((field[0] & 0x80) !== 0) fail(failureCode)
  const value = field.toString('ascii').replace(/\0.*$/u, '').trim()
  if (value === '') return 0
  if (!/^[0-7]+$/u.test(value)) fail(failureCode)
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(failureCode)
  return parsed
}

function findTarEntry(descriptor, archiveSize, expectedName, maximumBytes) {
  const failureCode = 'image_export_failed'
  const header = Buffer.alloc(TAR_BLOCK_BYTES)
  let match = null
  let position = 0
  let entryCount = 0
  try {
    while (position + TAR_BLOCK_BYTES <= archiveSize) {
      if (entryCount >= MAX_TAR_ENTRIES) fail(failureCode)
      entryCount += 1
      readExactly(descriptor, header, position, failureCode)
      if (header.every((value) => value === 0)) break

      const expectedChecksum = tarOctalField(header, 148, 8, failureCode)
      let actualChecksum = 0
      for (let index = 0; index < header.length; index += 1) {
        actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index]
      }
      if (actualChecksum !== expectedChecksum) fail(failureCode)

      const name = tarTextField(header, 0, 100)
      const prefix = tarTextField(header, 345, 155)
      const fullName = prefix === '' ? name : `${prefix}/${name}`
      const entrySize = tarOctalField(header, 124, 12, failureCode)
      const typeFlag = header[156]
      const dataPosition = position + TAR_BLOCK_BYTES
      const paddedSize = Math.ceil(entrySize / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
      const nextPosition = dataPosition + paddedSize
      if (
        !Number.isSafeInteger(nextPosition)
        || nextPosition < dataPosition
        || nextPosition > archiveSize
      ) {
        fail(failureCode)
      }

      if (fullName === expectedName) {
        if (
          match !== null
          || ![0, 0x30].includes(typeFlag)
          || entrySize < 1
          || entrySize > maximumBytes
        ) {
          fail(failureCode)
        }
        match = { dataPosition, entrySize }
      }
      position = nextPosition
    }
  } finally {
    header.fill(0)
  }
  if (match === null) fail(failureCode)
  return match
}

function readDockerArchiveImageId(filePath) {
  const failureCode = 'image_export_failed'
  const resolvedPath = assertSafePathHierarchy(filePath, { leafType: 'file' })
  let descriptor
  let manifestBuffer
  try {
    descriptor = openSync(
      resolvedPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const before = fstatSync(descriptor)
    if (
      !before.isFile()
      || before.size < TAR_BLOCK_BYTES * 3
      || !Number.isSafeInteger(before.size)
      || before.nlink !== 1
    ) {
      fail(failureCode)
    }

    const manifestEntry = findTarEntry(
      descriptor,
      before.size,
      'manifest.json',
      MAX_DOCKER_ARCHIVE_MANIFEST_BYTES,
    )
    manifestBuffer = Buffer.alloc(manifestEntry.entrySize)
    readExactly(
      descriptor,
      manifestBuffer,
      manifestEntry.dataPosition,
      failureCode,
    )
    let manifest
    try {
      const manifestText = new TextDecoder('utf-8', { fatal: true })
        .decode(manifestBuffer)
      manifest = JSON.parse(manifestText)
    } catch {
      fail(failureCode)
    }
    if (
      !Array.isArray(manifest)
      || manifest.length !== 1
      || !manifest[0]
      || typeof manifest[0] !== 'object'
      || typeof manifest[0].Config !== 'string'
    ) {
      fail(failureCode)
    }
    const configMatch = /^(?:blobs\/sha256\/([a-f0-9]{64})|([a-f0-9]{64})\.json)$/u
      .exec(manifest[0].Config)
    const configDigest = configMatch?.[1] ?? configMatch?.[2]
    if (!configDigest) fail(failureCode)

    const configEntry = findTarEntry(
      descriptor,
      before.size,
      manifest[0].Config,
      MAX_DOCKER_IMAGE_CONFIG_BYTES,
    )
    const configHash = createHash('sha256')
    const configBuffer = Buffer.allocUnsafe(Math.min(1024 * 1024, configEntry.entrySize))
    try {
      let remaining = configEntry.entrySize
      let position = configEntry.dataPosition
      while (remaining > 0) {
        const length = Math.min(configBuffer.length, remaining)
        const bytesRead = readSync(descriptor, configBuffer, 0, length, position)
        if (bytesRead !== length) fail(failureCode)
        configHash.update(configBuffer.subarray(0, bytesRead))
        remaining -= bytesRead
        position += bytesRead
      }
    } finally {
      configBuffer.fill(0)
    }
    if (configHash.digest('hex') !== configDigest) fail(failureCode)

    const after = fstatSync(descriptor)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.nlink !== 1
    ) {
      fail(failureCode)
    }
    return `sha256:${configDigest}`
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail(failureCode)
  } finally {
    manifestBuffer?.fill(0)
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // A fixed failure was already selected above if the read did not finish.
      }
    }
  }
}

function createTemporaryDirectory() {
  try {
    const temporaryRoot = assertSafePathHierarchy(tmpdir(), { leafType: 'directory' })
    const temporaryDirectory = mkdtempSync(
      path.join(temporaryRoot, TEMPORARY_DIRECTORY_PREFIX),
    )
    return assertSafePathHierarchy(temporaryDirectory, { leafType: 'directory' })
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail('image_export_failed')
  }
}

function removeTemporaryDirectory(temporaryDirectory) {
  const resolvedRoot = assertSafePathHierarchy(tmpdir(), { leafType: 'directory' })
  const resolvedDirectory = path.resolve(temporaryDirectory)
  assertPathInside(resolvedRoot, resolvedDirectory)
  if (!path.basename(resolvedDirectory).startsWith(TEMPORARY_DIRECTORY_PREFIX)) {
    fail('temporary_cleanup_failed')
  }
  assertSafePathHierarchy(resolvedDirectory, { leafType: 'directory' })
  try {
    rmSync(resolvedDirectory, { recursive: true, force: true })
    assertSafePathHierarchy(resolvedRoot, { leafType: 'directory' })
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail('temporary_cleanup_failed')
  }
}

function exportImage(runner, reference, temporaryDirectory, targetName) {
  const safeTemporaryDirectory = assertSafePathHierarchy(
    temporaryDirectory,
    { leafType: 'directory' },
  )
  const archivePath = safeArtifactPath(
    safeTemporaryDirectory,
    `${targetName}.tar`,
  )
  if (inspectSafeArtifact(safeTemporaryDirectory, `${targetName}.tar`).exists) {
    fail('image_export_failed')
  }
  runDocker(
    runner,
    ['image', 'save', '--output', archivePath, reference],
    { capture: false },
    'image_export_failed',
  )
  try {
    assertSafePathHierarchy(archivePath, { leafType: 'file' })
    const archive = lstatSync(archivePath)
    if (!archive.isFile() || archive.size < 1 || archive.nlink !== 1) {
      fail('image_export_failed')
    }
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail('image_export_failed')
  }
  return archivePath
}

function createScannerCache(runner) {
  const cacheVolume = `ediz-remote-trivy-${randomUUID()}`
  runDocker(
    runner,
    ['volume', 'create', '--label', 'org.ediz-remote.purpose=security-audit', cacheVolume],
    { capture: false, timeoutMs: 30_000 },
    'scanner_cache_failed',
  )
  return cacheVolume
}

function removeScannerCache(runner, cacheVolume) {
  runDocker(
    runner,
    ['volume', 'rm', '--force', cacheVolume],
    { capture: false, timeoutMs: 30_000 },
    'scanner_cache_failed',
  )
}

function createScannerExecution(temporaryDirectory) {
  const safeTemporaryDirectory = assertSafePathHierarchy(
    temporaryDirectory,
    { leafType: 'directory' },
  )
  const nonce = randomUUID()
  const name = `ediz-remote-security-audit-${nonce}`
  const cidFileName = `.scanner-${nonce}.cid`
  const cidFile = safeArtifactPath(safeTemporaryDirectory, cidFileName)
  if (inspectSafeArtifact(safeTemporaryDirectory, cidFileName).exists) {
    fail('scanner_container_cleanup_failed')
  }
  return { cidFile, cidFileName, name, temporaryDirectory: safeTemporaryDirectory }
}

function scannerSandboxArguments(cacheVolume, networkMode, execution) {
  return [
    'run',
    '--rm',
    '--name',
    execution.name,
    '--cidfile',
    execution.cidFile,
    '--log-driver',
    'none',
    '--cpus',
    '2',
    '--memory',
    '2g',
    '--memory-swap',
    '2g',
    '--pids-limit',
    '256',
    '--network',
    networkMode,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=256m',
    '--mount',
    `type=volume,source=${cacheVolume},target=/root/.cache/trivy`,
  ]
}

function cleanupScannerExecution(runner, execution) {
  let identifier = execution.name
  let cidFileExists = false
  let metadataFailure = false
  try {
    const cidFile = inspectSafeArtifact(
      execution.temporaryDirectory,
      execution.cidFileName,
    )
    cidFileExists = cidFile.exists
    if (cidFile.exists) {
      const containerId = readTrustedTextFile(
        execution.temporaryDirectory,
        execution.cidFileName,
        128,
        'scanner_container_cleanup_failed',
      ).trim()
      if (!/^[a-f0-9]{64}$/u.test(containerId)) {
        fail('scanner_container_cleanup_failed')
      }
      identifier = containerId
    }
  } catch {
    metadataFailure = true
    identifier = execution.name
    cidFileExists = false
  }

  let removalResult
  try {
    removalResult = runner(
      ['container', 'rm', '--force', '--volumes', identifier],
      { capture: false, timeoutMs: 30_000 },
    )
    if (
      (!removalResult || removalResult.status !== 0)
      && identifier !== execution.name
    ) {
      removalResult = runner(
        ['container', 'rm', '--force', '--volumes', execution.name],
        { capture: false, timeoutMs: 30_000 },
      )
    }
    if (!removalResult || removalResult.status !== 0) {
      const inspection = runner(
        ['container', 'inspect', execution.name, '--format', '{{.Id}}'],
        { capture: false, timeoutMs: 30_000 },
      )
      const daemon = runner(
        ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'],
        { capture: false, timeoutMs: 30_000 },
      )
      if (!inspection || inspection.status === 0 || !daemon || daemon.status !== 0) {
        fail('scanner_container_cleanup_failed')
      }
    }
    if (cidFileExists) removeSafeArtifact(
      execution.temporaryDirectory,
      execution.cidFileName,
    )
    if (metadataFailure) fail('scanner_container_cleanup_failed')
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail('scanner_container_cleanup_failed')
  }
}

function runManagedScannerContainer(
  runner,
  temporaryDirectory,
  cacheVolume,
  networkMode,
  containerArguments,
  options,
  acceptedStatuses,
  failureCode,
) {
  const execution = createScannerExecution(temporaryDirectory)
  let result = null
  let commandFailed = false
  try {
    result = runner(
      [
        ...scannerSandboxArguments(cacheVolume, networkMode, execution),
        ...containerArguments,
      ],
      options,
    )
    commandFailed = !result || !acceptedStatuses.has(result.status)
  } catch {
    commandFailed = true
  }
  cleanupScannerExecution(runner, execution)
  if (commandFailed) fail(failureCode)
  return result
}

function updateScannerDatabase(runner, cacheVolume, temporaryDirectory) {
  runManagedScannerContainer(
    runner,
    temporaryDirectory,
    cacheVolume,
    'bridge',
    [
      IMAGE_LOCKS.scanner,
      '--quiet',
      '--timeout',
      '10m',
      'image',
      '--skip-version-check',
      '--disable-telemetry',
      '--no-progress',
      '--download-db-only',
    ],
    { capture: false },
    new Set([0]),
    'scanner_database_failed',
  )
}

function readScannerDatabaseMetadata(runner, cacheVolume, temporaryDirectory) {
  const result = runManagedScannerContainer(
    runner,
    temporaryDirectory,
    cacheVolume,
    'none',
    [
      IMAGE_LOCKS.scanner,
      '--quiet',
      'version',
      '--format',
      'json',
    ],
    { capture: true, timeoutMs: 30_000 },
    new Set([0]),
    'scanner_database_failed',
  )
  const report = parseJsonReport(result.stdout, 'scanner_database_failed')
  const database = report.VulnerabilityDB
  if (
    report.Version !== '0.74.0'
    || database?.Version !== 2
    || !databaseTimestampsAreFresh(
      database?.UpdatedAt,
      database?.DownloadedAt,
    )
  ) {
    fail('scanner_database_failed')
  }
  return {
    downloadedAt: database.DownloadedAt,
    schemaVersion: database.Version,
    updatedAt: database.UpdatedAt,
  }
}

function databaseTimestampsAreFresh(updatedAtText, downloadedAtText, now = Date.now()) {
  if (typeof updatedAtText !== 'string' || typeof downloadedAtText !== 'string') {
    return false
  }
  const updatedAt = Date.parse(updatedAtText)
  const downloadedAt = Date.parse(downloadedAtText)
  return Number.isFinite(updatedAt)
    && Number.isFinite(downloadedAt)
    && updatedAt <= now + MAX_CLOCK_SKEW_MS
    && downloadedAt <= now + MAX_CLOCK_SKEW_MS
    && now - updatedAt <= MAX_DATABASE_AGE_MS
    && now - downloadedAt <= MAX_DATABASE_AGE_MS
}

function scannerArguments(archivePath, reportArguments) {
  return [
    '--mount',
    `type=bind,source=${archivePath},target=/input/image.tar,readonly`,
    IMAGE_LOCKS.scanner,
    '--quiet',
    '--timeout',
    '10m',
    'image',
    '--skip-version-check',
    '--disable-telemetry',
    '--offline-scan',
    '--skip-db-update',
    '--skip-java-db-update',
    '--skip-vex-repo-update',
    '--skip-check-update',
    '--no-progress',
    '--input',
    '/input/image.tar',
    '--ignorefile',
    '/dev/null',
    '--scanners',
    'vuln',
    ...reportArguments,
  ]
}

function runScanner(
  runner,
  temporaryDirectory,
  archivePath,
  cacheVolume,
  reportArguments,
  acceptedStatuses,
  failureCode,
) {
  return runManagedScannerContainer(
    runner,
    temporaryDirectory,
    cacheVolume,
    'none',
    scannerArguments(archivePath, reportArguments),
    { capture: true },
    acceptedStatuses,
    failureCode,
  )
}

function parseJsonReport(text, failureCode) {
  try {
    const report = JSON.parse(text)
    if (!report || typeof report !== 'object' || Array.isArray(report)) fail(failureCode)
    return report
  } catch (error) {
    if (error instanceof ContainerSecurityAuditError) throw error
    fail(failureCode)
  }
}

function serializeReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

function auditBinding(target) {
  return {
    archiveSha256: target.archiveSha256,
    imageId: target.imageId,
    imageConfigDigest: target.imageConfigDigest,
    platform: target.platform,
    sourceReference: target.sourceReference,
    target: target.name,
  }
}

function generateSboms(
  runner,
  temporaryDirectory,
  archivePath,
  cacheVolume,
  outputDirectory,
  target,
) {
  const cycloneResult = runScanner(
    runner,
    temporaryDirectory,
    archivePath,
    cacheVolume,
    ['--format', 'cyclonedx'],
    new Set([0]),
    'sbom_generation_failed',
  )
  const cycloneReport = parseJsonReport(cycloneResult.stdout, 'sbom_invalid')
  const cycloneComponent = cycloneReport.metadata?.component
  const cycloneProperties = cycloneComponent?.properties
  const reportedImageIds = Array.isArray(cycloneProperties)
    ? cycloneProperties
      .filter((item) => item?.name === 'aquasecurity:trivy:ImageID')
      .map((item) => item.value)
    : []
  if (
    cycloneReport.bomFormat !== 'CycloneDX'
    || typeof cycloneReport.specVersion !== 'string'
    || !/^urn:uuid:[0-9a-f-]+$/iu.test(cycloneReport.serialNumber)
    || !Array.isArray(cycloneReport.components)
    || cycloneReport.components.length === 0
    || !cycloneComponent
    || typeof cycloneComponent !== 'object'
    || typeof cycloneComponent.name !== 'string'
    || cycloneComponent.name.length === 0
    || reportedImageIds.length !== 1
    || reportedImageIds[0] !== target.imageConfigDigest
    || (
      cycloneComponent.properties !== undefined
      && !Array.isArray(cycloneComponent.properties)
    )
  ) {
    fail('sbom_invalid')
  }
  cycloneComponent.properties ??= []
  for (const [name, value] of Object.entries(auditBinding(target))) {
    cycloneComponent.properties.push({
      name: `ediz-remote:audit:${name}`,
      value,
    })
  }
  const cycloneContents = serializeReport(cycloneReport)
  const cycloneName = `${target.name}.cyclonedx.json`
  const cycloneSha256 = writeArtifact(
    outputDirectory,
    cycloneName,
    cycloneContents,
  )

  const spdxResult = runScanner(
    runner,
    temporaryDirectory,
    archivePath,
    cacheVolume,
    ['--format', 'spdx-json'],
    new Set([0]),
    'sbom_generation_failed',
  )
  const spdxReport = parseJsonReport(spdxResult.stdout, 'sbom_invalid')
  const containerPackages = Array.isArray(spdxReport.packages)
    ? spdxReport.packages.filter((item) => item?.primaryPackagePurpose === 'CONTAINER')
    : []
  const spdxImageIdComments = containerPackages.length === 1
    && Array.isArray(containerPackages[0].annotations)
    ? containerPackages[0].annotations
      .filter((annotation) => (
        annotation
        && typeof annotation === 'object'
        && typeof annotation.comment === 'string'
        && annotation.comment.startsWith('ImageID: ')
      ))
      .map((annotation) => annotation.comment)
    : []
  if (
    spdxReport.spdxVersion !== 'SPDX-2.3'
    || spdxReport.SPDXID !== 'SPDXRef-DOCUMENT'
    || spdxReport.dataLicense !== 'CC0-1.0'
    || typeof spdxReport.name !== 'string'
    || spdxReport.name.length === 0
    || typeof spdxReport.documentNamespace !== 'string'
    || !spdxReport.creationInfo
    || !Array.isArray(spdxReport.creationInfo.creators)
    || spdxReport.creationInfo.creators.length === 0
    || !Array.isArray(spdxReport.packages)
    || spdxReport.packages.length === 0
    || spdxReport.packages.some((item) => (
      !item
      || typeof item !== 'object'
      || typeof item.SPDXID !== 'string'
      || typeof item.name !== 'string'
      || item.name.length === 0
    ))
    || containerPackages.length !== 1
    || spdxImageIdComments.length !== 1
    || spdxImageIdComments[0] !== `ImageID: ${target.imageConfigDigest}`
  ) {
    fail('sbom_invalid')
  }
  const bindingText = JSON.stringify(auditBinding(target))
  spdxReport.documentComment = spdxReport.documentComment
    ? `${spdxReport.documentComment}\nEdiz Remote audit binding: ${bindingText}`
    : `Ediz Remote audit binding: ${bindingText}`
  const spdxContents = serializeReport(spdxReport)
  const spdxName = `${target.name}.spdx.json`
  const spdxSha256 = writeArtifact(outputDirectory, spdxName, spdxContents)
  return [
    {
      file: cycloneName,
      format: 'CycloneDX',
      itemCount: cycloneReport.components.length,
      sha256: cycloneSha256,
    },
    {
      file: spdxName,
      format: 'SPDX-2.3',
      itemCount: spdxReport.packages.length,
      sha256: spdxSha256,
    },
  ]
}

function scanHighAndCritical(
  runner,
  temporaryDirectory,
  archivePath,
  cacheVolume,
  outputDirectory,
  target,
) {
  const scanResult = runScanner(
    runner,
    temporaryDirectory,
    archivePath,
    cacheVolume,
    [
      '--severity',
      'HIGH,CRITICAL',
      '--exit-code',
      String(TRIVY_FINDINGS_EXIT_CODE),
      '--format',
      'json',
    ],
    new Set([0, TRIVY_FINDINGS_EXIT_CODE]),
    'vulnerability_scan_failed',
  )
  const report = parseJsonReport(scanResult.stdout, 'vulnerability_report_invalid')
  if (
    report.SchemaVersion !== 2
    || report.ArtifactType !== 'container_image'
    || report.Metadata?.ImageID !== target.imageConfigDigest
    || !Array.isArray(report.Results)
    || report.Results.length === 0
  ) {
    fail('vulnerability_report_invalid')
  }

  let findingCount = 0
  for (const result of report.Results) {
    if (
      !result
      || typeof result !== 'object'
      || typeof result.Target !== 'string'
      || result.Target.length === 0
    ) {
      fail('vulnerability_report_invalid')
    }
    const vulnerabilities = result.Vulnerabilities ?? []
    if (!Array.isArray(vulnerabilities)) fail('vulnerability_report_invalid')
    for (const vulnerability of vulnerabilities) {
      if (
        !vulnerability
        || !['HIGH', 'CRITICAL'].includes(vulnerability.Severity)
      ) {
        fail('vulnerability_report_invalid')
      }
      findingCount += 1
    }
  }

  if (
    (scanResult.status === TRIVY_FINDINGS_EXIT_CODE && findingCount === 0)
    || (scanResult.status === 0 && findingCount > 0)
  ) {
    fail('vulnerability_report_invalid')
  }
  report.ArtifactName = target.name
  report.EdizRemoteAudit = auditBinding(target)
  const reportContents = serializeReport(report)
  const reportName = `${target.name}.vulnerabilities.json`
  const reportSha256 = writeArtifact(
    outputDirectory,
    reportName,
    reportContents,
  )
  return {
    findingCount,
    report: {
      file: reportName,
      format: 'Trivy-JSON',
      itemCount: findingCount,
      sha256: reportSha256,
    },
  }
}

function cleanupTransientResources(runner, resources) {
  let cleanupFailure = null
  if (resources.temporaryDirectory) {
    try {
      removeTemporaryDirectory(resources.temporaryDirectory)
    } catch {
      cleanupFailure ??= 'temporary_cleanup_failed'
    }
  }
  if (resources.cacheVolume) {
    try {
      removeScannerCache(runner, resources.cacheVolume)
    } catch {
      cleanupFailure ??= 'scanner_cache_failed'
    }
  }
  return cleanupFailure
}

function tryReleaseAuditLock(lock) {
  try {
    releaseAuditLock(lock)
    return null
  } catch {
    return 'audit_lock_failed'
  }
}

export function runContainerSecurityAudit(options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT,
  )
  const runner = options.runner ?? createDockerRunner()
  const log = options.log ?? console.log
  const explicitOutputDirectory = options.outputDirectory
    ? path.resolve(options.outputDirectory)
    : null
  const releaseDirectories = deploymentOutputDirectories(explicitOutputDirectory)
    .map((directory) => path.resolve(directory))
  const lockDirectory = explicitOutputDirectory ?? DEFAULT_OUTPUT_DIRECTORY
  const resources = {
    cacheVolume: null,
    lock: null,
    temporaryDirectory: null,
  }

  let auditResult = null
  let outputDirectory = explicitOutputDirectory
  let primaryError = null
  try {
    resources.lock = acquireAuditLock(lockDirectory)
    invalidateReleaseArtifacts(releaseDirectories)
    loadPinnedImageConfiguration(repositoryRoot)
    const platform = assertDockerAvailable(runner)
    const platformName = platform.replace('/', '-')
    outputDirectory ??= path.join(DEFAULT_OUTPUT_DIRECTORY, platformName)
    prepareOutputDirectory(outputDirectory)
    log('container_security_audit:docker_ready')

    pullAndVerifyImage(
      runner,
      IMAGE_LOCKS.scanner,
      platform,
      'scanner_unavailable',
    )
    pullAndVerifyImage(
      runner,
      IMAGE_LOCKS.node,
      platform,
      'image_pull_failed',
    )
    pullAndVerifyImage(
      runner,
      IMAGE_LOCKS.coturn,
      platform,
      'image_pull_failed',
    )
    log('container_security_audit:pinned_images_verified')

    resources.temporaryDirectory = createTemporaryDirectory()
    const nodeBaseImageId = buildNodeBaseImage(
      runner,
      repositoryRoot,
      resources.temporaryDirectory,
      platform,
    )
    const applicationImageId = buildApplicationImage(
      runner,
      repositoryRoot,
      resources.temporaryDirectory,
      platform,
    )
    const coturnImageId = buildCoturnImage(
      runner,
      repositoryRoot,
      resources.temporaryDirectory,
      platform,
    )
    log('container_security_audit:runtime_images_built')

    resources.cacheVolume = createScannerCache(runner)
    updateScannerDatabase(
      runner,
      resources.cacheVolume,
      resources.temporaryDirectory,
    )
    const database = readScannerDatabaseMetadata(
      runner,
      resources.cacheVolume,
      resources.temporaryDirectory,
    )
    log('container_security_audit:scanner_database_ready')

    const targets = [
      {
        imageId: nodeBaseImageId,
        name: 'node-base',
        platform,
        sourceReference: IMAGE_LOCKS.node,
      },
      {
        imageId: applicationImageId,
        name: 'application',
        platform,
        sourceReference: applicationImageId,
      },
      {
        imageId: coturnImageId,
        name: 'coturn',
        platform,
        sourceReference: coturnImageId,
      },
    ]
    const findingCounts = new Map()
    const targetEvidence = []
    for (const target of targets) {
      const archivePath = exportImage(
        runner,
        target.imageId,
        resources.temporaryDirectory,
        target.name,
      )
      target.imageConfigDigest = readDockerArchiveImageId(archivePath)
      target.archiveSha256 = sha256File(archivePath)
      const reports = generateSboms(
        runner,
        resources.temporaryDirectory,
        archivePath,
        resources.cacheVolume,
        outputDirectory,
        target,
      )
      const vulnerabilityResult = scanHighAndCritical(
        runner,
        resources.temporaryDirectory,
        archivePath,
        resources.cacheVolume,
        outputDirectory,
        target,
      )
      reports.push(vulnerabilityResult.report)
      const finalArchiveSha256 = sha256File(
        archivePath,
        'image_archive_changed',
      )
      if (finalArchiveSha256 !== target.archiveSha256) {
        fail('image_archive_changed')
      }
      findingCounts.set(target.name, vulnerabilityResult.findingCount)
      targetEvidence.push({
        ...auditBinding(target),
        highCriticalFindings: vulnerabilityResult.findingCount,
        reports,
      })
      removeSafeArtifact(resources.temporaryDirectory, `${target.name}.tar`)
      log(`container_security_audit:target_scanned:${target.name}`)
    }

    const totalFindings = [...findingCounts.values()]
      .reduce((total, count) => total + count, 0)
    const manifest = {
      applicationImage: applicationImageId,
      coturnBaseImage: IMAGE_LOCKS.coturn,
      coturnImage: coturnImageId,
      database,
      platform,
      scanner: IMAGE_LOCKS.scanner,
      schemaVersion: 3,
      targets: targetEvidence,
    }
    if (totalFindings > 0) {
      writeArtifact(
        outputDirectory,
        'container-audit-manifest.json',
        serializeReport({ ...manifest, gatePassed: false }),
      )
      fail('high_critical_findings')
    }

    auditResult = {
      applicationImage: applicationImageId,
      artifactNames: expectedArtifactNames(),
      findingCounts: Object.fromEntries(findingCounts),
      manifest: { ...manifest, gatePassed: true },
      coturnImage: coturnImageId,
      outputDirectoryName: path.basename(outputDirectory),
      platform,
    }
  } catch (error) {
    primaryError = error
  }

  const cleanupFailure = cleanupTransientResources(runner, resources)
  if (primaryError || cleanupFailure) {
    let invalidationError = null
    try {
      invalidateReleaseArtifacts(
        releaseDirectories,
        cleanupFailure !== null,
      )
    } catch (error) {
      invalidationError = error
    }
    const lockFailure = resources.lock
      ? tryReleaseAuditLock(resources.lock)
      : null
    if (primaryError) throw primaryError
    if (cleanupFailure) fail(cleanupFailure)
    if (invalidationError) throw invalidationError
    if (lockFailure) fail(lockFailure)
  }

  let manifestSha256
  try {
    manifestSha256 = writeArtifact(
      outputDirectory,
      'container-audit-manifest.json',
      serializeReport(auditResult.manifest),
    )
    writeArtifact(
      outputDirectory,
      'deployment.env',
      [
        `EDIZ_REMOTE_APP_IMAGE=${auditResult.applicationImage}`,
        `EDIZ_REMOTE_COTURN_IMAGE=${auditResult.coturnImage}`,
        `EDIZ_REMOTE_AUDIT_MANIFEST_SHA256=${manifestSha256}`,
        '',
      ].join('\n'),
    )
  } catch (error) {
    try {
      invalidateReleaseArtifacts([outputDirectory], true)
    } catch {
      // The original fixed artifact failure remains authoritative.
    }
    tryReleaseAuditLock(resources.lock)
    throw error
  }

  const lockFailure = tryReleaseAuditLock(resources.lock)
  resources.lock = null
  if (lockFailure) {
    try {
      invalidateReleaseArtifacts([outputDirectory], true)
    } catch {
      // A release reference must not be trusted after any lock failure.
    }
    fail(lockFailure)
  }

  log('container_security_audit:passed')
  const { manifest: _manifest, ...publicResult } = auditResult
  return publicResult
}

function parseDeploymentEnvironment(contents) {
  const match = /^EDIZ_REMOTE_APP_IMAGE=(sha256:[a-f0-9]{64})\r?\nEDIZ_REMOTE_COTURN_IMAGE=(sha256:[a-f0-9]{64})\r?\nEDIZ_REMOTE_AUDIT_MANIFEST_SHA256=([a-f0-9]{64})\r?\n$/u.exec(contents)
  if (!match) fail('deployment_invalid')
  return {
    applicationImage: match[1],
    coturnImage: match[2],
    manifestSha256: match[3],
  }
}

function verifyDeploymentEvidence(outputDirectory, platform) {
  const safeOutputDirectory = assertSafePathHierarchy(
    outputDirectory,
    { leafType: 'directory' },
  )
  const deploymentContents = readTrustedTextFile(
    safeOutputDirectory,
    'deployment.env',
    512,
    'deployment_invalid',
  )
  const deployment = parseDeploymentEnvironment(deploymentContents)
  const manifestContents = readTrustedTextFile(
    safeOutputDirectory,
    'container-audit-manifest.json',
    4 * 1024 * 1024,
    'deployment_invalid',
  )
  const manifestSha256 = createHash('sha256')
    .update(manifestContents, 'utf8')
    .digest('hex')
  if (manifestSha256 !== deployment.manifestSha256) fail('deployment_invalid')
  const manifest = parseJsonReport(manifestContents, 'deployment_invalid')
  if (
    manifest.schemaVersion !== 3
    || manifest.gatePassed !== true
    || manifest.platform !== platform
    || manifest.applicationImage !== deployment.applicationImage
    || manifest.coturnBaseImage !== IMAGE_LOCKS.coturn
    || manifest.coturnImage !== deployment.coturnImage
    || manifest.scanner !== IMAGE_LOCKS.scanner
    || manifest.database?.schemaVersion !== 2
    || !databaseTimestampsAreFresh(
      manifest.database?.updatedAt,
      manifest.database?.downloadedAt,
    )
    || !Array.isArray(manifest.targets)
    || manifest.targets.length !== TARGET_NAMES.length
  ) {
    fail('deployment_invalid')
  }

  const expectedReportNames = new Set(
    TARGET_NAMES.flatMap((targetName) => [
      `${targetName}.cyclonedx.json`,
      `${targetName}.spdx.json`,
      `${targetName}.vulnerabilities.json`,
    ]),
  )
  const verifiedReportNames = new Set()
  const verifiedTargetNames = new Set()
  const expectedSourceReferences = new Map([
    ['node-base', IMAGE_LOCKS.node],
    ['application', manifest.applicationImage],
    ['coturn', manifest.coturnImage],
  ])
  for (const target of manifest.targets) {
    if (
      !target
      || !TARGET_NAMES.includes(target.target)
      || verifiedTargetNames.has(target.target)
      || target.platform !== platform
      || target.sourceReference !== expectedSourceReferences.get(target.target)
      || !/^sha256:[a-f0-9]{64}$/u.test(target.imageId)
      || !/^sha256:[a-f0-9]{64}$/u.test(target.imageConfigDigest)
      || !/^[a-f0-9]{64}$/u.test(target.archiveSha256)
      || target.highCriticalFindings !== 0
      || !Array.isArray(target.reports)
      || target.reports.length !== 3
    ) {
      fail('deployment_invalid')
    }
    verifiedTargetNames.add(target.target)
    for (const report of target.reports) {
      if (
        !report
        || !expectedReportNames.has(report.file)
        || !report.file.startsWith(`${target.target}.`)
        || verifiedReportNames.has(report.file)
        || !/^[a-f0-9]{64}$/u.test(report.sha256)
      ) {
        fail('deployment_invalid')
      }
      const reportContents = readTrustedTextFile(
        safeOutputDirectory,
        report.file,
        MAX_CAPTURE_BYTES + 1024 * 1024,
        'deployment_invalid',
      )
      const reportSha256 = createHash('sha256')
        .update(reportContents, 'utf8')
        .digest('hex')
      if (reportSha256 !== report.sha256) fail('deployment_invalid')
      verifiedReportNames.add(report.file)
    }
  }
  if (
    verifiedReportNames.size !== expectedReportNames.size
    || verifiedTargetNames.size !== TARGET_NAMES.length
    || [...expectedReportNames].some((name) => !verifiedReportNames.has(name))
    || manifest.targets.find((target) => target.target === 'application')?.imageId
      !== manifest.applicationImage
    || manifest.targets.find((target) => target.target === 'coturn')?.imageId
      !== manifest.coturnImage
  ) {
    fail('deployment_invalid')
  }
  return {
    ...deployment,
    deploymentEnvironmentPath: safeArtifactPath(
      safeOutputDirectory,
      'deployment.env',
    ),
  }
}

export function runContainerDeployment(options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT,
  )
  const runner = options.runner ?? createDockerRunner()
  const log = options.log ?? console.log
  const explicitOutputDirectory = options.outputDirectory
    ? path.resolve(options.outputDirectory)
    : null
  const lockDirectory = explicitOutputDirectory ?? DEFAULT_OUTPUT_DIRECTORY
  const lock = acquireAuditLock(lockDirectory, 'deployment_locked')
  let primaryError = null
  try {
    loadPinnedImageConfiguration(repositoryRoot)
    const platform = assertDockerAvailable(runner)
    const outputDirectory = explicitOutputDirectory
      ?? path.join(DEFAULT_OUTPUT_DIRECTORY, platform.replace('/', '-'))
    const evidence = verifyDeploymentEvidence(outputDirectory, platform)
    const imageResult = runDocker(
      runner,
      ['image', 'inspect', evidence.applicationImage, '--format', '{{.Id}}'],
      { capture: true, timeoutMs: 30_000 },
      'deployment_invalid',
    )
    if (imageResult.stdout.trim() !== evidence.applicationImage) {
      fail('deployment_invalid')
    }
    const coturnImageResult = runDocker(
      runner,
      ['image', 'inspect', evidence.coturnImage, '--format', '{{.Id}}'],
      { capture: true, timeoutMs: 30_000 },
      'deployment_invalid',
    )
    if (coturnImageResult.stdout.trim() !== evidence.coturnImage) {
      fail('deployment_invalid')
    }
    const environmentFile = assertPathInside(
      repositoryRoot,
      path.resolve(options.environmentFile ?? path.join(repositoryRoot, '.env')),
    )
    assertSafePathHierarchy(environmentFile, { leafType: 'file' })
    const composeFile = assertPathInside(
      repositoryRoot,
      path.join(repositoryRoot, 'docker-compose.yml'),
    )
    assertSafePathHierarchy(composeFile, { leafType: 'file' })
    const coturnComposeFile = assertPathInside(
      repositoryRoot,
      path.join(repositoryRoot, 'infra', 'coturn', 'compose.yml'),
    )
    assertSafePathHierarchy(coturnComposeFile, { leafType: 'file' })
    const deploymentEnvironment = {
      EDIZ_REMOTE_APP_IMAGE: evidence.applicationImage,
      EDIZ_REMOTE_AUDIT_MANIFEST_SHA256: evidence.manifestSha256,
      EDIZ_REMOTE_COTURN_IMAGE: evidence.coturnImage,
      EDIZ_REMOTE_DEPLOYMENT_VALIDATED: evidence.manifestSha256,
    }
    runDocker(
      runner,
      [
        'compose',
        '--env-file',
        environmentFile,
        '--env-file',
        evidence.deploymentEnvironmentPath,
        '--file',
        composeFile,
        'up',
        '--detach',
        '--no-build',
        '--pull',
        'never',
        '--wait',
        '--wait-timeout',
        '120',
      ],
      {
        capture: false,
        environment: deploymentEnvironment,
      },
      'deployment_failed',
    )
    verifyDeployedContainer(
      runner,
      'ediz-remote',
      evidence.applicationImage,
      evidence.manifestSha256,
    )
    runDocker(
      runner,
      [
        'compose',
        '--env-file',
        environmentFile,
        '--env-file',
        evidence.deploymentEnvironmentPath,
        '--file',
        coturnComposeFile,
        'up',
        '--detach',
        '--no-build',
        '--pull',
        'never',
        '--wait',
        '--wait-timeout',
        '120',
      ],
      {
        capture: false,
        environment: deploymentEnvironment,
      },
      'deployment_failed',
    )
    verifyDeployedContainer(
      runner,
      'ediz-remote-coturn',
      evidence.coturnImage,
      evidence.manifestSha256,
    )
  } catch (error) {
    primaryError = error
  }
  const lockFailure = tryReleaseAuditLock(lock)
  if (primaryError) throw primaryError
  if (lockFailure) fail(lockFailure)
  log('container_deployment:passed')
}

function verifyDeployedContainer(
  runner,
  containerName,
  expectedImage,
  expectedManifestSha256,
) {
  const format = `{{printf "%s|%s|%s|%t|%s" .Image (index .Config.Labels "${AUDIT_LABEL}") (index .Config.Labels "${AUDIT_IMAGE_LABEL}") .State.Running .State.Health.Status}}`
  const result = runDocker(
    runner,
    ['container', 'inspect', containerName, '--format', format],
    { capture: true, timeoutMs: 30_000 },
    'deployment_failed',
  )
  const expected = [
    expectedImage,
    expectedManifestSha256,
    expectedImage,
    'true',
    'healthy',
  ].join('|')
  if (result.stdout.trim() !== expected) fail('deployment_failed')
}

function isMainModule() {
  if (!process.argv[1]) return false
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isMainModule()) {
  if (process.argv.length !== 2) {
    console.error('container_security_audit_failed:configuration_invalid')
    process.exitCode = 1
  } else {
    try {
      runContainerSecurityAudit()
    } catch (error) {
      const code = error instanceof ContainerSecurityAuditError
        ? error.code
        : 'internal_error'
      console.error(`container_security_audit_failed:${code}`)
      process.exitCode = 1
    }
  }
}
