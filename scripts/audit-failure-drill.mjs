// Isolated Docker drill for the documented audit failure behaviour:
// runtime audit write failure -> /health 503 -> new upgrades rejected ->
// fixed `audit_unavailable` non-zero exit -> restart policy -> recovery.
// Every Docker resource is created under a unique drill prefix; nothing else
// is inspected for mutation, stopped or removed. Output is fixed-format only.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { redactSensitiveText } from './safe-output.mjs'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')

export const DRILL_RESOURCE_PREFIX = 'ediz-remote-audit-drill-'
export const DRILL_IMAGE_TAG = 'ediz-remote/audit-drill:local'
export const DRILL_LABEL = 'org.ediz-remote.audit-drill'
// Same pinned helper image as scripts/browser-turn-simulation.mjs.
export const HELPER_IMAGE =
  'alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce'
export const SIGNALING_SUBPROTOCOL = 'ediz-remote.v3'
export const SIGNALING_PROTOCOL_VERSION = 3
export const AUDIT_DIRECTORY = '/var/lib/ediz-remote/security-audit'
export const SECRETS_DIRECTORY = '/run/secrets'
// Mirrors docker-compose.yml; the unit test keeps both in sync.
export const TMPFS_OPTIONS =
  'size=64m,mode=0700,uid=1000,gid=1000,noexec,nosuid,nodev'
export const HEALTHCHECK_SCRIPT =
  "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
export const HEALTHCHECK_SHELL_COMMAND = `node -e "${HEALTHCHECK_SCRIPT}"`
export const ALLOWED_ORIGIN = 'https://app.ediz-remote.local'
export const FOREIGN_ORIGIN = 'https://foreign.audit-drill.invalid'
const CONTAINER_PORT = 8080
const SUPPORTED_PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64'])
const SERVICE_ERROR_CODES = Object.freeze([
  'startup_failed',
  'audit_unavailable',
  'shutdown_failed',
  'unhandled_exception',
  'unhandled_rejection',
])
const RESOURCE_KINDS = Object.freeze([
  'signaling',
  'net',
  'audit',
  'secrets',
])
const HELPER_STEPS = Object.freeze([
  'secrets',
  'inspect',
  'inject',
  'restore',
])
const NONCE_PATTERN = /^[a-f0-9]{12}$/u
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u
const IMAGE_REFERENCE_PATTERN =
  /^[a-z0-9][a-z0-9._/-]{0,199}(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/u
const RESOURCE_NAME_PATTERN = new RegExp(
  `^${DRILL_RESOURCE_PREFIX}[a-f0-9]{12}-(?:${RESOURCE_KINDS.join('|')}|helper-(?:${HELPER_STEPS.join('|')}))$`,
  'u',
)
const SAFE_TOKEN_PATTERN = /^[a-z0-9_]{1,64}$/u
const SAFE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/u
const IMAGE_PLACEHOLDER = 'image_id_placeholder'
const DEFAULT_ATTEMPTS = 3
const MAX_ATTEMPTS = 5
const BUILD_TIMEOUT_MS = 30 * 60 * 1_000
const DOCKER_TIMEOUT_MS = 60_000
const HEALTHY_TIMEOUT_MS = 150_000
const OBSERVATION_WINDOW_MS = 10_000
const EXIT_TIMEOUT_MS = 15_000
const RESTART_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 50
const MAX_LOG_SEQUENCE = 12

const FAILURE_CODES = new Set([
  'usage_invalid',
  'docker_cli_unavailable',
  'docker_daemon_unavailable',
  'docker_context_invalid',
  'linux_engine_required',
  'stale_resources_present',
  'dockerfile_target_invalid',
  'image_build_failed',
  'image_invalid',
  'resource_setup_failed',
  'secret_setup_failed',
  'container_start_failed',
  'container_config_mismatch',
  'port_mapping_invalid',
  'baseline_unhealthy',
  'baseline_health_invalid',
  'baseline_upgrade_invalid',
  'baseline_audit_write_failed',
  'baseline_log_invalid',
  'injection_failed',
  'trigger_unexpected_status',
  'failure_not_observed',
  'exit_not_observed',
  'exit_code_invalid',
  'restart_not_observed',
  'failure_log_invalid',
  'restore_failed',
  'recovery_unhealthy',
  'recovery_health_invalid',
  'recovery_upgrade_invalid',
  'recovery_audit_write_failed',
  'recovery_log_invalid',
  'cleanup_failed',
  'output_unsafe',
  'interrupted',
  'internal_error',
])

export class AuditDrillError extends Error {
  constructor(code) {
    super(code)
    this.name = 'AuditDrillError'
    this.code = FAILURE_CODES.has(code) ? code : 'internal_error'
  }
}

function fail(code) {
  throw new AuditDrillError(code)
}

export function failureCodeOf(error) {
  return error instanceof AuditDrillError ? error.code : 'internal_error'
}

export function parseArguments(argv) {
  const options = { image: null, attempts: DEFAULT_ATTEMPTS, help: false }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (seen.has(argument)) fail('usage_invalid')
    seen.add(argument)
    if (argument === '--help' || argument === '-h') {
      options.help = true
    } else if (argument === '--image') {
      const value = argv[index + 1]
      index += 1
      if (typeof value !== 'string' || !isSafeImageReference(value)) {
        fail('usage_invalid')
      }
      options.image = value
    } else if (argument === '--attempts') {
      const value = argv[index + 1]
      index += 1
      if (typeof value !== 'string' || !/^[1-9]$/u.test(value)) {
        fail('usage_invalid')
      }
      const attempts = Number.parseInt(value, 10)
      if (attempts > MAX_ATTEMPTS) fail('usage_invalid')
      options.attempts = attempts
    } else {
      fail('usage_invalid')
    }
  }
  return options
}

export function isSafeImageReference(value) {
  return typeof value === 'string'
    && (IMAGE_ID_PATTERN.test(value) || IMAGE_REFERENCE_PATTERN.test(value))
}

export function createDrillNames(nonce) {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
    fail('internal_error')
  }
  const base = `${DRILL_RESOURCE_PREFIX}${nonce}`
  const names = {
    nonce,
    base,
    container: `${base}-signaling`,
    network: `${base}-net`,
    auditVolume: `${base}-audit`,
    secretVolume: `${base}-secrets`,
    helper: Object.fromEntries(
      HELPER_STEPS.map((step) => [step, `${base}-helper-${step}`]),
    ),
  }
  for (const name of [
    names.container,
    names.network,
    names.auditVolume,
    names.secretVolume,
    ...Object.values(names.helper),
  ]) {
    assertDrillResourceName(name, nonce)
  }
  return Object.freeze(names)
}

export function isDrillResourceName(name, nonce) {
  if (typeof name !== 'string' || !RESOURCE_NAME_PATTERN.test(name)) {
    return false
  }
  return nonce === undefined
    || name.startsWith(`${DRILL_RESOURCE_PREFIX}${nonce}-`)
}

export function assertDrillResourceName(name, nonce) {
  if (!isDrillResourceName(name, nonce)) fail('internal_error')
  return name
}

/** Docker name filters are substring matches; keep only real prefix hits. */
export function selectDrillResourceNames(text) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^\//u, ''))
    .filter((line) => line.startsWith(DRILL_RESOURCE_PREFIX))
}

export function resolveApplicationTarget(dockerfileText) {
  const stages = String(dockerfileText ?? '')
    .split(/\r?\n/u)
    .map((line) => /^FROM\s+\S+\s+AS\s+([A-Za-z][A-Za-z0-9_-]*)\s*$/iu.exec(line.trim())?.[1])
    .filter(Boolean)
  const target = stages.at(-1)
  if (!target || !/^[a-z][a-z0-9-]{0,39}$/u.test(target)) {
    fail('dockerfile_target_invalid')
  }
  return target
}

export function parsePublishedPort(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length !== 1) fail('port_mapping_invalid')
  const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(lines[0])
  const port = match ? Number.parseInt(match[1], 10) : 0
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail('port_mapping_invalid')
  }
  return port
}

export function classifyServiceLog(text) {
  const result = {
    ready: 0,
    unexpected: 0,
    codes: Object.fromEntries(SERVICE_ERROR_CODES.map((code) => [code, 0])),
    // Fixed tokens only, in log order; capped so output stays bounded.
    sequence: [],
  }
  const note = (token) => {
    if (result.sequence.length < MAX_LOG_SEQUENCE) result.sequence.push(token)
  }
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      result.unexpected += 1
      note('unexpected')
      continue
    }
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && parsed.type === 'service.ready'
      && parsed.port === CONTAINER_PORT
      && Object.keys(parsed).length === 2
    ) {
      result.ready += 1
      note('ready')
    } else if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && parsed.type === 'service.error'
      && SERVICE_ERROR_CODES.includes(parsed.code)
      && Object.keys(parsed).length === 2
    ) {
      result.codes[parsed.code] += 1
      note(parsed.code)
    } else {
      result.unexpected += 1
      note('unexpected')
    }
  }
  return result
}

function errorCount(classification) {
  return Object.values(classification.codes).reduce((sum, count) => sum + count, 0)
}

export function isBaselineLog(classification) {
  return classification.ready === 1
    && classification.unexpected === 0
    && errorCount(classification) === 0
}

/**
 * After the drill the log may contain only the startup line(s), the fixed
 * `audit_unavailable` exit, and fixed restart-loop codes while the injected
 * fault is still present. Unknown lines or unhandled_* codes are failures.
 */
export function isExpectedFailureLog(classification) {
  return classification.unexpected === 0
    && classification.ready >= 1
    && classification.codes.audit_unavailable >= 1
    && classification.codes.unhandled_exception === 0
    && classification.codes.unhandled_rejection === 0
}

export function classifyHealthResponse(statusCode, bodyText) {
  let body
  try {
    body = JSON.parse(bodyText)
  } catch {
    return 'invalid'
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid'
  const keys = Object.keys(body).sort().join(',')
  if (
    statusCode === 200
    && body.status === 'ok'
    && keys === 'sessions,status'
    && Number.isInteger(body.sessions)
  ) {
    return 'ok'
  }
  if (statusCode === 503 && body.status === 'unavailable' && keys === 'status') {
    return 'unavailable'
  }
  return 'invalid'
}

export function classifyNetworkError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined
  if (code === 'ECONNREFUSED') return 'refused'
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset'
  if (code === 'ETIMEDOUT' || code === 'drill_timeout') return 'timeout'
  return 'other'
}

export function evaluateContainerHardening(inspect, names) {
  const issues = []
  const hostConfig = inspect?.HostConfig ?? {}
  const config = inspect?.Config ?? {}
  const capDrop = Array.isArray(hostConfig.CapDrop)
    ? hostConfig.CapDrop.map((value) => String(value).toUpperCase())
    : []
  if (hostConfig.ReadonlyRootfs !== true) issues.push('read_only')
  if (!capDrop.includes('ALL')) issues.push('cap_drop')
  if (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length > 0) {
    issues.push('cap_add')
  }
  if (hostConfig.Privileged === true) issues.push('privileged')
  if (
    !Array.isArray(hostConfig.SecurityOpt)
    || !hostConfig.SecurityOpt.some((option) => /^no-new-privileges(?:[:=]true)?$/u.test(option))
  ) {
    issues.push('no_new_privileges')
  }
  if (hostConfig.PidsLimit !== 256) issues.push('pids_limit')
  if (hostConfig.RestartPolicy?.Name !== 'unless-stopped') {
    issues.push('restart_policy')
  }
  if (hostConfig.NetworkMode !== names?.network) issues.push('network')
  const tmpfs = hostConfig.Tmpfs?.['/tmp']
  if (
    typeof tmpfs !== 'string'
    || [...tmpfs.split(',')].sort().join(',')
      !== [...TMPFS_OPTIONS.split(',')].sort().join(',')
  ) {
    issues.push('tmpfs')
  }
  const bindings = hostConfig.PortBindings?.[`${CONTAINER_PORT}/tcp`]
  if (
    !hostConfig.PortBindings
    || Object.keys(hostConfig.PortBindings).length !== 1
    || !Array.isArray(bindings)
    || bindings.length !== 1
    || bindings[0]?.HostIp !== '127.0.0.1'
  ) {
    issues.push('port_binding')
  }
  if (config.User !== '1000:1000') issues.push('user')
  const environment = new Set(Array.isArray(config.Env) ? config.Env : [])
  for (const required of [
    'NODE_ENV=production',
    'SIGNALING_AUDIT_ENABLED=true',
    `SIGNALING_AUDIT_DIRECTORY=${AUDIT_DIRECTORY}`,
    `SIGNALING_AUDIT_HMAC_KEY_FILE=${SECRETS_DIRECTORY}/signaling_audit_hmac`,
    `TURN_SHARED_SECRET_FILE=${SECRETS_DIRECTORY}/turn_shared_secret`,
  ]) {
    if (!environment.has(required)) issues.push('environment')
  }
  if ([...environment].some((entry) => /^(?:TURN_SHARED_SECRET|SIGNALING_AUDIT_HMAC_KEY)=/u.test(entry))) {
    issues.push('inline_secret')
  }
  const healthcheck = config.Healthcheck ?? {}
  if (
    !Array.isArray(healthcheck.Test)
    || healthcheck.Test.length !== 2
    || healthcheck.Test[0] !== 'CMD-SHELL'
    || healthcheck.Test[1] !== HEALTHCHECK_SHELL_COMMAND
    || healthcheck.Interval !== 30e9
    || healthcheck.Timeout !== 5e9
    || healthcheck.Retries !== 3
    || healthcheck.StartPeriod !== 10e9
  ) {
    issues.push('healthcheck')
  }
  const mounts = Array.isArray(inspect?.Mounts) ? inspect.Mounts : []
  const auditMount = mounts.find((mount) => mount?.Destination === AUDIT_DIRECTORY)
  const secretMount = mounts.find((mount) => mount?.Destination === SECRETS_DIRECTORY)
  if (
    mounts.length !== 2
    || auditMount?.Type !== 'volume'
    || auditMount?.Name !== names?.auditVolume
    || auditMount?.RW !== true
    || secretMount?.Type !== 'volume'
    || secretMount?.Name !== names?.secretVolume
    || secretMount?.RW !== false
  ) {
    issues.push('mounts')
  }
  return [...new Set(issues)]
}

export function buildSignalingRunArguments(names, imageId) {
  if (!IMAGE_ID_PATTERN.test(imageId)) fail('image_invalid')
  const environment = [
    `PORT=${CONTAINER_PORT}`,
    'NODE_ENV=production',
    'ICE_STUN_URLS=stun:stun.cloudflare.com:3478',
    // Syntactically valid, never contacted: TURN is configured so the secret
    // file path is exercised exactly as in production.
    'TURN_URLS=turn:turn.audit-drill.invalid:3478?transport=udp',
    `TURN_SHARED_SECRET_FILE=${SECRETS_DIRECTORY}/turn_shared_secret`,
    'TURN_CREDENTIAL_TTL_SECONDS=3600',
    `SIGNALING_ALLOWED_ORIGINS=${ALLOWED_ORIGIN}`,
    'TRUST_CLOUDFLARE_CONNECTING_IP=true',
    'SIGNALING_MAX_CONNECTIONS=256',
    'SIGNALING_MAX_CONNECTIONS_PER_IP=16',
    'SIGNALING_MAX_SESSIONS=96',
    'SIGNALING_MAX_SESSIONS_PER_IP=4',
    'SIGNALING_AUDIT_ENABLED=true',
    `SIGNALING_AUDIT_DIRECTORY=${AUDIT_DIRECTORY}`,
    'SIGNALING_AUDIT_RETENTION_DAYS=7',
    `SIGNALING_AUDIT_HMAC_KEY_FILE=${SECRETS_DIRECTORY}/signaling_audit_hmac`,
    'EDIZ_REMOTE_BUILD_ID=ediz-remote@audit-drill',
  ]
  return [
    'run',
    '--detach',
    '--name',
    assertDrillResourceName(names.container, names.nonce),
    '--label',
    `${DRILL_LABEL}=${names.nonce}`,
    '--network',
    assertDrillResourceName(names.network, names.nonce),
    '--restart',
    'unless-stopped',
    '--read-only',
    '--pids-limit',
    '256',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    `/tmp:${TMPFS_OPTIONS}`,
    '--publish',
    `127.0.0.1::${CONTAINER_PORT}`,
    '--mount',
    `type=volume,source=${assertDrillResourceName(names.auditVolume, names.nonce)},target=${AUDIT_DIRECTORY}`,
    '--mount',
    `type=volume,source=${assertDrillResourceName(names.secretVolume, names.nonce)},target=${SECRETS_DIRECTORY},readonly`,
    '--health-cmd',
    HEALTHCHECK_SHELL_COMMAND,
    '--health-interval',
    '30s',
    '--health-timeout',
    '5s',
    '--health-retries',
    '3',
    '--health-start-period',
    '10s',
    ...environment.flatMap((entry) => ['--env', entry]),
    imageId,
  ]
}

export function buildHelperArguments(names, step, volumeName, script, options = {}) {
  if (!HELPER_STEPS.includes(step)) fail('internal_error')
  return [
    'run',
    '--rm',
    ...(options.stdin ? ['--interactive'] : []),
    '--name',
    assertDrillResourceName(names.helper[step], names.nonce),
    '--label',
    `${DRILL_LABEL}=${names.nonce}`,
    '--network',
    'none',
    '--log-driver',
    'none',
    '--read-only',
    '--pids-limit',
    '16',
    '--cap-drop',
    'ALL',
    ...HELPER_CAPABILITIES[step].flatMap((capability) => ['--cap-add', capability]),
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    '0:0',
    '--mount',
    `type=volume,source=${assertDrillResourceName(volumeName, names.nonce)},target=/drill`,
    HELPER_IMAGE,
    'sh',
    '-c',
    script,
  ]
}

// Least privilege per helper step: ownership changes need CHOWN/FOWNER, the
// read-only inspection only needs to list the UID 1000 0700 audit directory.
export const HELPER_CAPABILITIES = Object.freeze({
  secrets: Object.freeze(['CHOWN', 'FOWNER']),
  inspect: Object.freeze(['DAC_READ_SEARCH']),
  inject: Object.freeze(['CHOWN', 'FOWNER']),
  restore: Object.freeze(['CHOWN', 'FOWNER']),
})

export const HELPER_SCRIPTS = Object.freeze({
  // Reads two random lines from stdin; values never reach argv or output.
  secrets: [
    'set -eu',
    'umask 077',
    'IFS= read -r audit_key',
    'IFS= read -r turn_secret',
    'printf %s "$audit_key" > /drill/signaling_audit_hmac',
    'printf %s "$turn_secret" > /drill/turn_shared_secret',
    'unset audit_key turn_secret',
    'chown 1000:1000 /drill/signaling_audit_hmac /drill/turn_shared_secret',
    'chmod 0400 /drill/signaling_audit_hmac /drill/turn_shared_secret',
    'chown 0:0 /drill',
    'chmod 0755 /drill',
    'stat -c "%u:%g %a" /drill/signaling_audit_hmac /drill/turn_shared_secret',
  ].join('\n'),
  inspect: [
    'set -eu',
    'set -o pipefail',
    'stat -c "%u:%g %a" /drill',
    'find /drill -mindepth 1 -maxdepth 1 -type f -name "audit-*.jsonl" | wc -l',
  ].join('\n'),
  // Fault: the writer (UID 1000) can no longer open, inspect or chmod its
  // directory. Mode stays 0700 so only ownership differs.
  inject: [
    'set -eu',
    'chown 0:0 /drill',
    'chmod 0700 /drill',
    'stat -c "%u:%g %a" /drill',
  ].join('\n'),
  restore: [
    'set -eu',
    'chown 1000:1000 /drill',
    'chmod 0700 /drill',
    'stat -c "%u:%g %a" /drill',
  ].join('\n'),
})

export function formatDrillLine(phase, result, fields = {}, exactSecrets = []) {
  if (!SAFE_TOKEN_PATTERN.test(phase) || !SAFE_TOKEN_PATTERN.test(result)) {
    fail('output_unsafe')
  }
  const parts = [`audit_drill:${phase}:${result}`]
  const imageIds = []
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_KEY_PATTERN.test(key)) fail('output_unsafe')
    if (typeof value === 'string' && IMAGE_ID_PATTERN.test(value)) {
      // A public content digest is validated by shape; its hex digits must
      // not trip the numeric code pattern of the shared redaction boundary.
      if (exactSecrets.some((secret) => typeof secret === 'string' && secret.length >= 4 && value.includes(secret))) {
        fail('output_unsafe')
      }
      imageIds.push(value)
      parts.push(`${key}=${IMAGE_PLACEHOLDER}`)
    } else {
      parts.push(`${key}=${formatFieldValue(value)}`)
    }
  }
  const line = parts.join(' ')
  if (redactSensitiveText(line, exactSecrets) !== line) fail('output_unsafe')
  let index = 0
  return line.replaceAll(IMAGE_PLACEHOLDER, () => imageIds[index++])
}

function formatFieldValue(value) {
  if (typeof value === 'boolean') return String(value)
  if (Number.isInteger(value) && value >= -255 && value <= 99_999) {
    return String(value)
  }
  if (typeof value === 'string' && SAFE_TOKEN_PATTERN.test(value)) {
    return value
  }
  if (typeof value === 'string' && /^(?:\d{1,5}ms|\d{1,5}\.\ds)$/u.test(value)) {
    return value
  }
  if (Array.isArray(value) && value.length <= 16) {
    const items = value.map((item) => formatFieldValue(item))
    return items.length === 0 ? 'none' : items.join(',')
  }
  fail('output_unsafe')
}

export function formatDuration(milliseconds) {
  const value = Math.max(0, Math.round(milliseconds))
  return value < 100_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`
}

export function createDockerRunner() {
  return (argumentsList, options = {}) => {
    const result = spawnSync('docker', argumentsList, {
      encoding: 'utf8',
      input: options.input,
      maxBuffer: 16 * 1024 * 1024,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? DOCKER_TIMEOUT_MS,
      windowsHide: true,
    })
    return {
      notFound: result.error?.code === 'ENOENT',
      status: Number.isInteger(result.status) ? result.status : null,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    }
  }
}

function runDocker(runner, argumentsList, failureCode, options = {}) {
  let result
  try {
    result = runner(argumentsList, options)
  } catch {
    fail(failureCode)
  }
  if (!result || result.status !== 0) fail(failureCode)
  return result
}

export function assertDockerAvailable(runner) {
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
      { timeoutMs: 30_000 },
    )
  } catch {
    fail('docker_cli_unavailable')
  }
  if (result?.notFound) fail('docker_cli_unavailable')
  if (result?.status !== 0) fail('docker_daemon_unavailable')
  const platform = result.stdout.trim()
  if (!SUPPORTED_PLATFORMS.includes(platform)) fail('linux_engine_required')

  const context = runDocker(
    runner,
    ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
    'docker_context_invalid',
    { timeoutMs: 30_000 },
  )
  let host
  try {
    host = JSON.parse(context.stdout)
  } catch {
    fail('docker_context_invalid')
  }
  // Remote engines are refused: the drill must stay on this machine.
  if (typeof host !== 'string' || !/^(?:npipe|unix):\/\//u.test(host)) {
    fail('docker_context_invalid')
  }
  return platform
}

export function findStaleDrillResources(runner) {
  const filter = `name=${DRILL_RESOURCE_PREFIX}`
  const listings = [
    ['container', 'ls', '--all', '--filter', filter, '--format', '{{.Names}}'],
    ['volume', 'ls', '--filter', filter, '--format', '{{.Name}}'],
    ['network', 'ls', '--filter', filter, '--format', '{{.Name}}'],
  ]
  let count = 0
  for (const listing of listings) {
    const result = runDocker(runner, listing, 'docker_daemon_unavailable')
    count += selectDrillResourceNames(result.stdout).length
  }
  return count
}

function countResourcesForNonce(runner, names) {
  const filter = `name=${names.base}-`
  const listings = [
    ['container', 'ls', '--all', '--filter', filter, '--format', '{{.Names}}'],
    ['volume', 'ls', '--filter', filter, '--format', '{{.Name}}'],
    ['network', 'ls', '--filter', filter, '--format', '{{.Name}}'],
  ]
  let count = 0
  for (const listing of listings) {
    const result = runner(listing, {})
    if (!result || result.status !== 0) return null
    count += selectDrillResourceNames(result.stdout)
      .filter((name) => isDrillResourceName(name, names.nonce)).length
  }
  return count
}

function buildImage(runner, platform) {
  const dockerfilePath = path.join(REPOSITORY_ROOT, 'Dockerfile')
  const target = resolveApplicationTarget(readFileSync(dockerfilePath, 'utf8'))
  const result = runDocker(
    runner,
    [
      'build',
      '--quiet',
      '--platform',
      platform,
      '--target',
      target,
      '--label',
      `${DRILL_LABEL}=image`,
      '--tag',
      DRILL_IMAGE_TAG,
      '--file',
      dockerfilePath,
      REPOSITORY_ROOT,
    ],
    'image_build_failed',
    { timeoutMs: BUILD_TIMEOUT_MS },
  )
  const imageId = result.stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? ''
  if (!IMAGE_ID_PATTERN.test(imageId)) fail('image_invalid')
  return { imageId, target }
}

function inspectImage(runner, reference, platform) {
  const result = runDocker(
    runner,
    ['image', 'inspect', reference, '--format', '{{.Id}}|{{.Os}}/{{.Architecture}}|{{.Config.User}}'],
    'image_invalid',
  )
  const [imageId, imagePlatform, user] = result.stdout.trim().split('|')
  if (
    !IMAGE_ID_PATTERN.test(imageId ?? '')
    || imagePlatform !== platform
    || user !== '1000:1000'
  ) {
    fail('image_invalid')
  }
  return imageId
}

function runHelper(runner, names, step, volumeName, failureCode, input) {
  const result = runDocker(
    runner,
    buildHelperArguments(names, step, volumeName, HELPER_SCRIPTS[step], {
      stdin: input !== undefined,
    }),
    failureCode,
    { input, timeoutMs: 120_000 },
  )
  return result.stdout.trim().split(/\r?\n/u).map((line) => line.trim())
}

function inspectContainer(runner, names) {
  const result = runner(
    ['container', 'inspect', assertDrillResourceName(names.container, names.nonce), '--format', '{{json .}}'],
    {},
  )
  if (!result || result.status !== 0) return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

function containerSnapshot(inspect) {
  return {
    running: inspect?.State?.Running === true,
    status: typeof inspect?.State?.Status === 'string' ? inspect.State.Status : 'unknown',
    health: typeof inspect?.State?.Health?.Status === 'string'
      ? inspect.State.Health.Status
      : 'none',
    restartCount: Number.isInteger(inspect?.RestartCount) ? inspect.RestartCount : -1,
    exitCode: Number.isInteger(inspect?.State?.ExitCode) ? inspect.State.ExitCode : null,
    imageId: typeof inspect?.Image === 'string' ? inspect.Image : '',
  }
}

function readServiceLog(runner, names) {
  const result = runner(
    ['container', 'logs', assertDrillResourceName(names.container, names.nonce)],
    {},
  )
  if (!result || result.status !== 0) return null
  // Raw log text stays in memory; only fixed-code counts leave this function.
  return classifyServiceLog(`${result.stdout}\n${result.stderr}`)
}

function readPublishedPort(runner, names) {
  const result = runDocker(
    runner,
    ['container', 'port', assertDrillResourceName(names.container, names.nonce), `${CONTAINER_PORT}/tcp`],
    'port_mapping_invalid',
  )
  return parsePublishedPort(result.stdout)
}

const sleep = (milliseconds) => new Promise((resolveSleep) => {
  setTimeout(resolveSleep, milliseconds)
})

async function waitFor(check, timeoutMs, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() >= deadline) return null
    await sleep(intervalMs)
  }
}

export function requestHealth(port, timeoutMs = 1_000) {
  return new Promise((resolveRequest) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolveRequest(value)
    }
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        agent: false,
        headers: { Connection: 'close' },
      },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size <= 4_096) chunks.push(chunk)
        })
        response.on('end', () => {
          finish({
            statusCode: response.statusCode ?? null,
            outcome: classifyHealthResponse(
              response.statusCode,
              Buffer.concat(chunks).toString('utf8'),
            ),
          })
        })
        response.on('error', (error) => {
          finish({ statusCode: null, outcome: classifyNetworkError(error) })
        })
      },
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error('timeout'), { code: 'drill_timeout' }))
    })
    request.on('error', (error) => {
      finish({ statusCode: null, outcome: classifyNetworkError(error) })
    })
    request.end()
  })
}

export function attemptUpgrade(port, origin, timeoutMs = 2_000) {
  return new Promise((resolveAttempt) => {
    let settled = false
    let socket
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.terminate()
      } catch {
        // The attempt result is already recorded.
      }
      resolveAttempt(value)
    }
    const timer = setTimeout(() => {
      finish({ statusCode: null, ready: false, outcome: 'timeout' })
    }, timeoutMs)
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, SIGNALING_SUBPROTOCOL, {
        origin,
        handshakeTimeout: timeoutMs,
        perMessageDeflate: false,
        followRedirects: false,
      })
    } catch {
      finish({ statusCode: null, ready: false, outcome: 'other' })
      return
    }
    socket.on('unexpected-response', (request, response) => {
      const statusCode = response.statusCode ?? null
      response.resume()
      request.destroy()
      finish({ statusCode, ready: false, outcome: 'rejected' })
    })
    socket.on('message', (data, isBinary) => {
      let ready = false
      if (!isBinary) {
        try {
          const message = JSON.parse(data.toString('utf8'))
          ready = message?.type === 'ready'
            && message.protocolVersion === SIGNALING_PROTOCOL_VERSION
        } catch {
          ready = false
        }
      }
      finish({ statusCode: 101, ready, outcome: ready ? 'ready' : 'invalid' })
    })
    socket.on('error', (error) => {
      finish({ statusCode: null, ready: false, outcome: classifyNetworkError(error) })
    })
    socket.on('close', () => {
      finish({ statusCode: 101, ready: false, outcome: 'closed' })
    })
  })
}

function startDieEventListener(names) {
  const exits = []
  let child
  try {
    child = spawn(
      'docker',
      [
        'events',
        '--filter',
        `container=${assertDrillResourceName(names.container, names.nonce)}`,
        '--filter',
        'event=die',
        '--format',
        '{{.Actor.Attributes.exitCode}}',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    )
  } catch {
    return { exits, stop() {} }
  }
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    const lines = buffered.split(/\r?\n/u)
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      const value = line.trim()
      if (/^\d{1,3}$/u.test(value)) {
        exits.push({ at: Date.now(), exitCode: Number.parseInt(value, 10) })
      }
    }
  })
  child.on('error', () => {})
  return {
    exits,
    stop() {
      // Only this drill's own `docker events` child is terminated.
      if (child.exitCode === null && !child.killed) child.kill()
    },
  }
}

export async function runAuditDrill(options, dependencies = {}) {
  const runner = dependencies.runner ?? createDockerRunner()
  const emit = dependencies.emit ?? ((line) => console.log(line))
  const exactSecrets = []
  const print = (phase, result, fields) => {
    emit(formatDrillLine(phase, result, fields, exactSecrets))
  }
  const startedAt = Date.now()
  const elapsed = () => formatDuration(Date.now() - startedAt)

  const platform = assertDockerAvailable(runner)
  if (findStaleDrillResources(runner) > 0) fail('stale_resources_present')
  print('preflight', 'passed', { platform: platform.replace('/', '_') })

  let imageId
  const buildStartedAt = Date.now()
  if (options.image) {
    imageId = inspectImage(runner, options.image, platform)
    print('image', 'existing', { imageId })
  } else {
    const built = buildImage(runner, platform)
    imageId = inspectImage(runner, built.imageId, platform)
    if (imageId !== built.imageId) fail('image_invalid')
    print('image', 'built', {
      imageId,
      target: built.target,
      duration: formatDuration(Date.now() - buildStartedAt),
    })
  }

  const names = createDrillNames(randomBytes(6).toString('hex'))
  const state = { names, events: null, cleaned: false }
  const cleanup = () => cleanupDrill(runner, state)
  const onSignal = () => {
    const ok = cleanup()
    emit(`audit_drill:cleanup:${ok ? 'passed' : 'failed'}`)
    emit('audit_drill:failed:interrupted')
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  let phaseError = null
  try {
    await runDrillPhases({ runner, names, imageId, state, print, exactSecrets, elapsed, options })
  } catch (error) {
    phaseError = error
  }
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  const cleaned = cleanup()
  emit(`audit_drill:cleanup:${cleaned ? 'passed' : 'failed'}`)
  if (phaseError) throw phaseError
  if (!cleaned) fail('cleanup_failed')
  print('summary', 'passed', { imageId, total: elapsed() })
  return { imageId }
}

async function runDrillPhases({ runner, names, imageId, state, print, exactSecrets, elapsed, options }) {
  // Resources: the drill's own network and volumes, labelled and prefixed.
  runDocker(runner, ['network', 'create', '--driver', 'bridge', '--label', `${DRILL_LABEL}=${names.nonce}`, names.network], 'resource_setup_failed')
  runDocker(runner, ['volume', 'create', '--label', `${DRILL_LABEL}=${names.nonce}`, names.auditVolume], 'resource_setup_failed')
  runDocker(runner, ['volume', 'create', '--label', `${DRILL_LABEL}=${names.nonce}`, names.secretVolume], 'resource_setup_failed')

  const auditKey = randomBytes(48).toString('base64url')
  const turnSecret = randomBytes(48).toString('base64url')
  exactSecrets.push(auditKey, turnSecret)
  const secretState = runHelper(
    runner,
    names,
    'secrets',
    names.secretVolume,
    'secret_setup_failed',
    `${auditKey}\n${turnSecret}\n`,
  )
  if (secretState.length !== 2 || secretState.some((line) => line !== '1000:1000 400')) {
    fail('secret_setup_failed')
  }
  print('resources', 'created', { secretOwner: 'uid_1000', secretMode: '0400' })

  // Baseline.
  runDocker(runner, buildSignalingRunArguments(names, imageId), 'container_start_failed')
  const inspect = inspectContainer(runner, names)
  if (!inspect || containerSnapshot(inspect).imageId !== imageId) fail('container_start_failed')
  const issues = evaluateContainerHardening(inspect, names)
  if (issues.length > 0) {
    print('hardening', 'failed', { issues })
    fail('container_config_mismatch')
  }
  print('hardening', 'passed', {
    readOnly: true,
    capDrop: 'all',
    noNewPrivileges: true,
    pidsLimit: 256,
    user: 'uid_1000',
    restart: 'unless_stopped',
    loopbackOnly: true,
  })

  const healthyAt = Date.now()
  const healthy = await waitFor(() => {
    const snapshot = containerSnapshot(inspectContainer(runner, names))
    return snapshot.running && snapshot.health === 'healthy' ? snapshot : null
  }, HEALTHY_TIMEOUT_MS)
  if (!healthy) fail('baseline_unhealthy')
  let port = readPublishedPort(runner, names)
  const baselineHealth = await requestHealth(port)
  if (baselineHealth.statusCode !== 200 || baselineHealth.outcome !== 'ok') {
    fail('baseline_health_invalid')
  }
  const baselineUpgrade = await attemptUpgrade(port, ALLOWED_ORIGIN)
  if (baselineUpgrade.statusCode !== 101 || !baselineUpgrade.ready) {
    fail('baseline_upgrade_invalid')
  }
  // A rejected foreign-origin upgrade is an audited event: proves the writer
  // can persist before the fault is injected.
  const baselineAudit = await attemptUpgrade(port, FOREIGN_ORIGIN)
  await sleep(1_500)
  const afterBaselineAudit = await requestHealth(port)
  const baselineDirectory = runHelper(runner, names, 'inspect', names.auditVolume, 'baseline_audit_write_failed')
  const baselineSnapshot = containerSnapshot(inspectContainer(runner, names))
  const directoryState = baselineDirectory[0] === '1000:1000 700'
    ? 'owner_uid_1000_mode_0700'
    : 'unexpected'
  const auditFiles = /^\d{1,4}$/u.test(baselineDirectory[1] ?? '')
    ? Number.parseInt(baselineDirectory[1], 10)
    : -1
  if (
    baselineAudit.statusCode !== 403
    || afterBaselineAudit.statusCode !== 200
    || directoryState !== 'owner_uid_1000_mode_0700'
    || auditFiles < 1
    || !baselineSnapshot.running
    || baselineSnapshot.restartCount !== 0
  ) {
    print('baseline_audit', 'failed', {
      foreignOrigin: baselineAudit.statusCode ?? baselineAudit.outcome,
      health: afterBaselineAudit.statusCode ?? afterBaselineAudit.outcome,
      auditDirectory: directoryState,
      auditFiles,
      running: baselineSnapshot.running,
      restartCount: baselineSnapshot.restartCount,
    })
    fail('baseline_audit_write_failed')
  }
  const baselineLog = readServiceLog(runner, names)
  if (!baselineLog || !isBaselineLog(baselineLog)) fail('baseline_log_invalid')
  print('baseline', 'passed', {
    container: healthy.health,
    health: baselineHealth.statusCode,
    upgradeV3: baselineUpgrade.statusCode,
    foreignOrigin: baselineAudit.statusCode,
    auditWrite: 'ok',
    auditFiles,
    restartCount: baselineSnapshot.restartCount,
    logReady: baselineLog.ready,
    logOther: baselineLog.unexpected + errorCount(baselineLog),
    waited: formatDuration(Date.now() - healthyAt),
  })

  state.events = startDieEventListener(names)
  await sleep(1_000)

  let observation = null
  let restartCount = baselineSnapshot.restartCount
  for (let attempt = 1; attempt <= options.attempts && !observation; attempt += 1) {
    const injected = runHelper(runner, names, 'inject', names.auditVolume, 'injection_failed')
    if (injected[0] !== '0:0 700') fail('injection_failed')
    const preTrigger = await requestHealth(port)
    print('inject', 'applied', {
      attempt,
      auditDirectory: 'owner_root_mode_0700',
      healthBeforeTrigger: preTrigger.statusCode ?? preTrigger.outcome,
    })

    const exitsBefore = state.events.exits.length
    const triggeredAt = Date.now()
    const trigger = await attemptUpgrade(port, FOREIGN_ORIGIN)
    if (trigger.statusCode !== 403) fail('trigger_unexpected_status')

    let health503At = null
    let upgrade503At = null
    const healthStatuses = new Set()
    const upgradeStatuses = new Set()
    const windowEnd = triggeredAt + OBSERVATION_WINDOW_MS
    while (Date.now() < windowEnd && (health503At === null || upgrade503At === null)) {
      const [health, upgrade] = await Promise.all([
        requestHealth(port, 500),
        attemptUpgrade(port, ALLOWED_ORIGIN, 500),
      ])
      healthStatuses.add(health.statusCode ?? health.outcome)
      upgradeStatuses.add(upgrade.statusCode ?? upgrade.outcome)
      if (health.statusCode === 503 && health.outcome === 'unavailable' && health503At === null) {
        health503At = Date.now()
      }
      if (upgrade.statusCode === 503 && upgrade503At === null) upgrade503At = Date.now()
      if (state.events.exits.length > exitsBefore) break
      await sleep(POLL_INTERVAL_MS)
    }

    const died = await waitFor(
      () => state.events.exits[exitsBefore] ?? null,
      EXIT_TIMEOUT_MS,
      100,
    )
    if (!died) fail('exit_not_observed')
    if (died.exitCode === 0) fail('exit_code_invalid')
    const restarted = await waitFor(() => {
      const snapshot = containerSnapshot(inspectContainer(runner, names))
      return snapshot.restartCount > restartCount ? snapshot : null
    }, RESTART_TIMEOUT_MS, 200)
    if (!restarted) fail('restart_not_observed')
    restartCount = restarted.restartCount

    const observed = health503At !== null && upgrade503At !== null
    print('failure', observed ? 'observed' : 'window_missed', {
      attempt,
      trigger: trigger.statusCode,
      healthStatuses: [...healthStatuses].map(String).map(safeStatusToken),
      upgradeStatuses: [...upgradeStatuses].map(String).map(safeStatusToken),
      health503After: health503At === null ? 'none' : formatDuration(health503At - triggeredAt),
      upgrade503After: upgrade503At === null ? 'none' : formatDuration(upgrade503At - triggeredAt),
      exitCode: died.exitCode,
      exitAfter: formatDuration(died.at - triggeredAt),
      restartCount: restarted.restartCount,
    })
    if (observed) {
      observation = { attempt, died, restarted }
      break
    }
    // The 503 window lasts until the next watchdog tick; if a poll missed it,
    // restore and retry so the evidence is complete rather than inferred.
    await restoreAndRecover(runner, names, print, attempt)
    port = readPublishedPort(runner, names)
    restartCount = containerSnapshot(inspectContainer(runner, names)).restartCount
  }
  if (!observation) fail('failure_not_observed')

  // While the fault persists the service must keep failing closed at startup.
  const loopObserved = await waitFor(() => {
    const log = readServiceLog(runner, names)
    return log && log.codes.startup_failed >= 1 ? log : null
  }, 20_000, 500)
  const loopSnapshot = containerSnapshot(inspectContainer(runner, names))
  const failureLog = readServiceLog(runner, names)
  if (!failureLog || !isExpectedFailureLog(failureLog)) fail('failure_log_invalid')
  print('failure_log', 'passed', {
    auditUnavailable: failureLog.codes.audit_unavailable,
    startupFailed: failureLog.codes.startup_failed,
    shutdownFailed: failureLog.codes.shutdown_failed,
    unexpected: failureLog.unexpected,
    restartLoop: loopObserved !== null,
    restartCount: loopSnapshot.restartCount,
    sequence: failureLog.sequence,
  })

  await restoreAndRecover(runner, names, print, observation.attempt)
  port = readPublishedPort(runner, names)
  const recoveredHealth = await requestHealth(port)
  if (recoveredHealth.statusCode !== 200 || recoveredHealth.outcome !== 'ok') {
    fail('recovery_health_invalid')
  }
  const recoveredUpgrade = await attemptUpgrade(port, ALLOWED_ORIGIN)
  if (recoveredUpgrade.statusCode !== 101 || !recoveredUpgrade.ready) {
    fail('recovery_upgrade_invalid')
  }
  const beforeRecoveredAudit = containerSnapshot(inspectContainer(runner, names))
  const recoveredAudit = await attemptUpgrade(port, FOREIGN_ORIGIN)
  await sleep(1_500)
  const afterRecoveredAudit = await requestHealth(port)
  const afterRecoveredSnapshot = containerSnapshot(inspectContainer(runner, names))
  if (
    recoveredAudit.statusCode !== 403
    || afterRecoveredAudit.statusCode !== 200
    || !afterRecoveredSnapshot.running
    || afterRecoveredSnapshot.restartCount !== beforeRecoveredAudit.restartCount
  ) {
    fail('recovery_audit_write_failed')
  }
  const recoveryLog = readServiceLog(runner, names)
  if (
    !recoveryLog
    || !isExpectedFailureLog(recoveryLog)
    || recoveryLog.ready < 2
  ) {
    fail('recovery_log_invalid')
  }
  print('recovery', 'passed', {
    health: recoveredHealth.statusCode,
    upgradeV3: recoveredUpgrade.statusCode,
    foreignOrigin: recoveredAudit.statusCode,
    auditWrite: 'ok',
    restartCount: afterRecoveredSnapshot.restartCount,
    logReady: recoveryLog.ready,
    unexpected: recoveryLog.unexpected,
    elapsed: elapsed(),
  })
}

function safeStatusToken(value) {
  return /^\d{3}$/u.test(value) || SAFE_TOKEN_PATTERN.test(value) ? value : 'other'
}

async function restoreAndRecover(runner, names, print, attempt) {
  const restored = runHelper(runner, names, 'restore', names.auditVolume, 'restore_failed')
  if (restored[0] !== '1000:1000 700') fail('restore_failed')
  const restoredAt = Date.now()
  const healthy = await waitFor(() => {
    const snapshot = containerSnapshot(inspectContainer(runner, names))
    return snapshot.running && snapshot.health === 'healthy' ? snapshot : null
  }, HEALTHY_TIMEOUT_MS)
  if (!healthy) fail('recovery_unhealthy')
  print('restore', 'healthy', {
    attempt,
    auditDirectory: 'owner_uid_1000_mode_0700',
    container: healthy.health,
    restartCount: healthy.restartCount,
    healthyAfter: formatDuration(Date.now() - restoredAt),
  })
}

export function cleanupDrill(runner, state) {
  if (state.cleaned) return state.cleanupResult
  state.cleaned = true
  const { names } = state
  try {
    state.events?.stop()
  } catch {
    // Listener shutdown is best effort; resource verification below decides.
  }
  const commands = [
    ['container', 'rm', '--force', names.container],
    ...Object.values(names.helper).map((name) => ['container', 'rm', '--force', name]),
    ['network', 'rm', names.network],
    ['volume', 'rm', names.auditVolume],
    ['volume', 'rm', names.secretVolume],
  ]
  for (const command of commands) {
    // Every removal targets one exact drill-owned name; never a filter.
    assertDrillResourceName(command.at(-1), names.nonce)
    try {
      runner(command, { timeoutMs: 60_000 })
    } catch {
      // Missing resources are expected; the final listing is authoritative.
    }
  }
  let remaining = null
  try {
    remaining = countResourcesForNonce(runner, names)
  } catch {
    remaining = null
  }
  state.cleanupResult = remaining === 0
  return state.cleanupResult
}

function usage() {
  return [
    'Kullanım: npm run security:audit-drill -- [--image <image>] [--attempts <1-5>]',
    '  --image     Var olan image (ID ya da referans) build etmeden kullanılır.',
    '  --attempts  503 penceresi kaçarsa en çok kaç enjeksiyon denensin (varsayılan 3).',
  ].join('\n')
}

function isMainModule() {
  if (!process.argv[1]) return false
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isMainModule()) {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error(`audit_drill:failed:${failureCodeOf(error)}`)
    process.exitCode = 2
  }
  if (options?.help) {
    console.log(usage())
  } else if (options) {
    try {
      await runAuditDrill(options)
      console.log('audit_drill:passed')
    } catch (error) {
      console.error(`audit_drill:failed:${failureCodeOf(error)}`)
      process.exitCode = 1
    }
  }
}
