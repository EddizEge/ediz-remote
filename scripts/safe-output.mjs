const REDACTED = '[REDACTED]'
const TRUNCATED = '[TRUNCATED]'
const MAX_DIAGNOSTIC_DEPTH = 8
const MAX_DIAGNOSTIC_KEYS = 64
const MAX_DIAGNOSTIC_ITEMS = 64
const MAX_DIAGNOSTIC_STRING_LENGTH = 2_048
const MAX_DIAGNOSTIC_NODES = 512
const MAX_DIAGNOSTIC_JSON_LENGTH = 32_768
const MAX_RAW_TEXT_LENGTH = 64 * 1024
const MAX_EXACT_SECRETS = 256
const MAX_EXACT_SECRET_LENGTH = 4_096

// Structured diagnostics are an allowlist, not a denylist. Unknown keys are
// omitted so a newly introduced secret-bearing property cannot become output by
// default. String values are even stricter: only fixed operational enums survive.
const SAFE_DIAGNOSTIC_KEYS = new Set([
  'activity',
  'alert',
  'attempt',
  'bytes',
  'count',
  'currenttime',
  'deliverypercent',
  'diagnostics',
  'durationms',
  'elapsedms',
  'exitcode',
  'guest',
  'guestlogs',
  'height',
  'host',
  'hostlogs',
  'level',
  'maximumattempts',
  'outcome',
  'peer',
  'phase',
  'persisted',
  'readystate',
  'received',
  'safecount',
  'screenshot',
  'screenshareerror',
  'sent',
  'status',
  'statuscode',
  'title',
  'transport',
  'url',
  'width',
])

const SAFE_DIAGNOSTIC_STRING_VALUES = new Set([
  'debug',
  'direct',
  'ended',
  'failed',
  'guest',
  'host',
  'info',
  'passed',
  'relay',
  'severe',
  'system',
  'tcp',
  'udp',
  'unknown',
  'warning',
])

const SENSITIVE_KEYS = new Set([
  'address',
  'authorization',
  'candidate',
  'clientip',
  'code',
  'connectioncode',
  'credential',
  'error',
  'errortext',
  'exception',
  'hash',
  'ice',
  'ip',
  'message',
  'password',
  'reconnecttoken',
  'remoteaddress',
  'requestid',
  'resumetoken',
  'sdp',
  'secret',
  'sessionid',
  'stack',
  'token',
  'turncredential',
  'turnsecret',
  'username',
])

const SAFE_DIAGNOSTIC_NUMBER_RANGES = new Map([
  ['attempt', [0, 100]],
  ['bytes', [0, 32 * 1024 * 1024]],
  ['count', [0, 99_999]],
  ['currenttime', [0, 86_400]],
  ['deliverypercent', [0, 100]],
  ['durationms', [0, 86_400_000]],
  ['elapsedms', [0, 86_400_000]],
  ['exitcode', [-255, 255]],
  ['height', [0, 16_384]],
  ['maximumattempts', [0, 100]],
  ['readystate', [0, 4]],
  ['received', [0, 99_999]],
  ['safecount', [0, 99_999]],
  ['sent', [0, 99_999]],
  ['statuscode', [100, 599]],
  ['width', [0, 16_384]],
])

export function redactSensitiveText(value, exactSecrets = []) {
  let result
  try {
    result = String(value ?? '')
  } catch {
    return REDACTED
  }
  if (result.length > MAX_RAW_TEXT_LENGTH) return TRUNCATED

  const secrets = []
  if (Array.isArray(exactSecrets)) {
    for (const secret of exactSecrets) {
      if (secrets.length >= MAX_EXACT_SECRETS) break
      if (
        typeof secret === 'string' &&
        secret.length >= 4 &&
        secret.length <= MAX_EXACT_SECRET_LENGTH &&
        !secrets.includes(secret)
      ) {
        secrets.push(secret)
      }
    }
  }
  secrets.sort((left, right) => right.length - left.length)
  for (const secret of secrets) result = result.replaceAll(secret, REDACTED)

  return result
    .replace(/\bv=0(?:\\r\\n|\\n)[^\r\n]*/giu, '[REDACTED_SDP]')
    .replace(
      /(^|[\r\n])(?:v|o|s|i|u|e|p|c|b|t|r|z|k|a|m)=[^\r\n]*/gimu,
      '$1[REDACTED_SDP]',
    )
    .replace(/candidate:[^\r\n"\\]*/giu, '[REDACTED_ICE_CANDIDATE]')
    .replace(/a=ice-(?:ufrag|pwd):[^\r\n"\\]*/giu, 'a=ice-[REDACTED]')
    .replace(/\b\d{10}:[A-Za-z0-9._~+/-]{4,}\b/gu, '[REDACTED_TURN_USERNAME]')
    .replace(
      /((["']?\b(?:authorization|candidate|code|connection[-_]?code|credential|ice(?:[-_]?(?:pwd|ufrag))?|password|reconnect[-_]?token|resume[-_]?token|sdp|secret|session[-_]?id|token|turn[-_]?(?:credential|secret)|username)\b["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[REDACTED_IP]')
    .replace(/(?<![A-Za-z0-9])(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4}(?![A-Za-z0-9])/gu, '[REDACTED_IP]')
    .replace(/\b[A-Za-z0-9_-]{43}\b/gu, '[REDACTED_TOKEN]')
    .replace(/(?<!\d)\d{3}[ \u00a0\u202f-]?\d{3}(?!\d)/gu, '[REDACTED_CODE]')
    .replace(/file:\/\/\/(?:[A-Za-z]:[\\/]|(?:Users|app|config|data|etc|home|mnt|opt|root|run|srv|tmp|usr|var|workspace)\/)[^\s"'<>)]*/giu, '[REDACTED_PATH]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/gu, '[REDACTED_PATH]')
    .replace(/\b[A-Za-z]:(?![\\/])[^\s\r\n"'<>|]*[\\/][^\s\r\n"'<>|]*/gu, '[REDACTED_PATH]')
    .replace(/\\\\[^\\\s"'<>]+\\[^\r\n"'<>|]*/gu, '[REDACTED_PATH]')
    .replace(/(^|[\s"'(=])\/(?:Users|app|config|data|etc|home|mnt|opt|root|run|srv|tmp|usr|var|workspace)(?:\/[^\s"'<>]*)*/gmu, '$1[REDACTED_PATH]')
    .replace(/(^|[\s"'(=])\/[A-Za-z0-9._-][^\s\r\n"'<>]*/gmu, '$1[REDACTED_PATH]')
    .replace(/(^|[\s"'(=])(?:\.\.?[\\/])?(?:[A-Za-z0-9._-]+[\\/]){2,}[A-Za-z0-9._-]+(?::\d+(?::\d+)?)?/gmu, '$1[REDACTED_PATH]')
    .replace(/^\s*(?:at\s+.*|.*(?:Exception|Error)(?::|\s).*)$/gimu, '[REDACTED_EXCEPTION]')
}

export function sanitizeDiagnostic(value, exactSecrets = []) {
  return sanitizeValue(value, exactSecrets, 0, null, {
    remainingNodes: MAX_DIAGNOSTIC_NODES,
  })
}

export function safeDiagnosticJson(value, exactSecrets = []) {
  const output = JSON.stringify(sanitizeDiagnostic(value, exactSecrets))
  return output.length <= MAX_DIAGNOSTIC_JSON_LENGTH
    ? output
    : JSON.stringify({ _truncated: true })
}

function sanitizeValue(value, exactSecrets, depth, key, budget) {
  if (depth > MAX_DIAGNOSTIC_DEPTH || budget.remainingNodes <= 0) {
    return TRUNCATED
  }
  budget.remainingNodes -= 1
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    const range = SAFE_DIAGNOSTIC_NUMBER_RANGES.get(key)
    return Number.isFinite(value) &&
      range &&
      value >= range[0] &&
      value <= range[1] &&
      !(Number.isInteger(value) && value >= 100_000 && value <= 999_999)
      ? value
      : null
  }
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value, exactSecrets)
    if (
      redacted.length <= MAX_DIAGNOSTIC_STRING_LENGTH &&
      SAFE_DIAGNOSTIC_STRING_VALUES.has(redacted.toLowerCase())
    ) {
      return redacted
    }
    return REDACTED
  }
  if (Array.isArray(value)) {
    const items = []
    const itemCount = Math.min(value.length, MAX_DIAGNOSTIC_ITEMS)
    for (let index = 0; index < itemCount; index += 1) {
      items.push(sanitizeValue(value[index], exactSecrets, depth + 1, key, budget))
      if (budget.remainingNodes <= 0) break
    }
    if (items.length < itemCount || value.length > MAX_DIAGNOSTIC_ITEMS) {
      items.push(TRUNCATED)
    }
    return items
  }
  if (typeof value !== 'object') return '[UNSUPPORTED]'

  const result = {}
  let ownKeyCount = 0
  let outputKeyCount = 0
  let scannedKeyCount = 0
  try {
    for (const propertyKey in value) {
      scannedKeyCount += 1
      if (scannedKeyCount > MAX_DIAGNOSTIC_KEYS) {
        result._truncated = true
        break
      }
      if (!Object.hasOwn(value, propertyKey)) continue
      ownKeyCount += 1
      if (
        ownKeyCount > MAX_DIAGNOSTIC_KEYS ||
        budget.remainingNodes <= 0
      ) {
        result._truncated = true
        break
      }
      if (propertyKey.length > 64) continue
      const normalizedKey = normalizeKey(propertyKey)
      if (
        !isSensitiveKey(propertyKey) &&
        SAFE_DIAGNOSTIC_KEYS.has(normalizedKey)
      ) {
        result[normalizedKey] = sanitizeValue(
          value[propertyKey],
          exactSecrets,
          depth + 1,
          normalizedKey,
          budget,
        )
        outputKeyCount += 1
      }
    }
  } catch {
    return { _redacted: true }
  }
  if (outputKeyCount === 0 && ownKeyCount > 0 && !result._truncated) {
    result._redacted = true
  }
  return result
}

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(normalizeKey(key))
}

function normalizeKey(key) {
  return key.replaceAll(/[-_]/gu, '').toLowerCase()
}
