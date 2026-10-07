import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  redactSensitiveText,
  safeDiagnosticJson,
  sanitizeDiagnostic,
} from './safe-output.mjs'

const sentinels = {
  token: 'ER_SENTINEL_RESUME_TOKEN_12345678901234567890',
  secret: 'ER_SENTINEL_TURN_SECRET_12345678901234567890',
  credential: 'ER_SENTINEL_CREDENTIAL_12345678901234567890',
  sdp: 'v=0\\r\\na=ice-ufrag:ER_SENTINEL_SDP',
  candidate: 'candidate:ER_SENTINEL_ICE 1 udp 1 203.0.113.77 3478 typ host',
}

test('redacts exact secrets and common network identifiers from text', () => {
  const token = 'A'.repeat(43)
  const text = [
    sentinels.secret,
    '203.0.113.77',
    '2001:db8:85a3::8a2e:370:7334',
    '907056',
    '907 056',
    token,
    '1700000000:client-sensitive',
    'a=ice-pwd:ER_SENTINEL_ICE_PASSWORD',
    sentinels.candidate,
    'v=0\r\ns=ER_SENTINEL_SESSION\r\na=fingerprint:sha-256 ER_SENTINEL_FINGERPRINT',
    'Error: ER_SENTINEL_EXCEPTION\n    at run (C:\\Users\\Ediz\\secret.js:1:1)',
    'credential=ER_SENTINEL_GENERIC_CREDENTIAL',
    'v=0\\r\\no=ER_SENTINEL_ESCAPED_SDP\\r\\na=ice-pwd:SECRET',
    '\\\\fileserver\\private\\ER_SENTINEL_UNC.txt',
    '/opt/ediz-remote/ER_SENTINEL_OPT_PATH',
    'turn_credential=ER_SENTINEL_UNDERSCORE_CREDENTIAL',
    'reconnect-token=ER_SENTINEL_HYPHEN_TOKEN',
    'ice_pwd=ER_SENTINEL_UNDERSCORE_ICE',
    '/usr/local/bin/ER_SENTINEL_USR_PATH',
    'apps/web/src/ER_SENTINEL_RELATIVE_PATH.ts',
    '/github/workspace/ER_SENTINEL_GITHUB_PATH.ts',
    '/builds/team/ER_SENTINEL_BUILDS_PATH.ts',
    '/private/var/tmp/ER_SENTINEL_PRIVATE_PATH',
    '/Volumes/Secret/ER_SENTINEL_VOLUMES_PATH',
    'C:private\\ER_SENTINEL_DRIVE_RELATIVE.ts',
  ].join(' ')
  const safe = redactSensitiveText(text, [sentinels.secret])

  for (const forbidden of [
    sentinels.secret,
    '203.0.113.77',
    '2001:db8:85a3::8a2e:370:7334',
    '907056',
    '907 056',
    token,
    '1700000000:client-sensitive',
    'ER_SENTINEL_ICE_PASSWORD',
    sentinels.candidate,
    'ER_SENTINEL_SESSION',
    'ER_SENTINEL_FINGERPRINT',
    'ER_SENTINEL_EXCEPTION',
    'C:\\Users\\Ediz\\secret.js',
    'ER_SENTINEL_GENERIC_CREDENTIAL',
    'ER_SENTINEL_ESCAPED_SDP',
    'ER_SENTINEL_UNC',
    'ER_SENTINEL_OPT_PATH',
    'ER_SENTINEL_UNDERSCORE_CREDENTIAL',
    'ER_SENTINEL_HYPHEN_TOKEN',
    'ER_SENTINEL_UNDERSCORE_ICE',
    'ER_SENTINEL_USR_PATH',
    'ER_SENTINEL_RELATIVE_PATH',
    'ER_SENTINEL_GITHUB_PATH',
    'ER_SENTINEL_BUILDS_PATH',
    'ER_SENTINEL_PRIVATE_PATH',
    'ER_SENTINEL_VOLUMES_PATH',
    'ER_SENTINEL_DRIVE_RELATIVE',
  ]) assert.equal(safe.includes(forbidden), false)
})

test('serializes diagnostics through a bounded key allowlist', () => {
  const diagnostic = {
    phase: 'relay_probe',
    outcome: 'failed',
    token: sentinels.token,
    reconnect_token: sentinels.token,
    turnCredential: sentinels.credential,
    credential: sentinels.credential,
    sdp: sentinels.sdp,
    candidate: sentinels.candidate,
    ip: '203.0.113.77',
    errorText: 'driver leaked a secret',
    nested: { message: 'exception secret', safeCount: 7 },
    turnPasswordValue: 'ER_UNREGISTERED_SECRET_VALUE',
  }
  const safe = safeDiagnosticJson(diagnostic, Object.values(sentinels))

  for (const forbidden of [
    ...Object.values(sentinels),
    '203.0.113.77',
    'driver leaked a secret',
    'exception secret',
    'ER_UNREGISTERED_SECRET_VALUE',
    'turnPasswordValue',
  ]) assert.equal(safe.includes(forbidden), false)
  assert.deepEqual(sanitizeDiagnostic({ safeCount: 7 }), { safecount: 7 })
  assert.deepEqual(sanitizeDiagnostic({ token: sentinels.token }), {
    _redacted: true,
  })
  assert.deepEqual(sanitizeDiagnostic({ count: 907056 }), { count: null })
})

test('bounds diagnostic depth, item count and string length', () => {
  const deeplyNested = { safeCount: 1 }
  let cursor = deeplyNested
  for (let index = 0; index < 12; index += 1) {
    cursor.diagnostics = { safeCount: index + 2 }
    cursor = cursor.diagnostics
  }
  const result = safeDiagnosticJson({
    diagnostics: deeplyNested,
    hostLogs: Array.from({ length: 80 }, (_, index) => index),
    activity: 'x'.repeat(4_096),
  })

  assert.match(result, /\[TRUNCATED\]/u)
  assert.ok(result.length < 8_000)
  assert.doesNotMatch(result, /x{16}/u)
})

test('applies one global node budget across a wide diagnostic tree', () => {
  const diagnostic = {
    diagnostics: Array.from({ length: 64 }, () => ({
      diagnostics: Array.from({ length: 64 }, () => ({ safeCount: 1 })),
    })),
  }

  const result = safeDiagnosticJson(diagnostic)

  assert.ok(result.length <= 32_768)
  assert.match(result, /(?:_truncated|\[TRUNCATED\])/u)
})

test('bounds raw text, property names and inherited key scans', () => {
  assert.equal(redactSensitiveText('x'.repeat(64 * 1024 + 1)), '[TRUNCATED]')

  const longKey = `p${'_'.repeat(10_000)}hase`
  const longKeyResult = safeDiagnosticJson({ [longKey]: 'passed' })
  assert.ok(longKeyResult.length < 128)
  assert.equal(longKeyResult.includes(longKey), false)

  const inherited = {}
  for (let index = 0; index < 100; index += 1) {
    inherited[`unknown_${index}`] = index
  }
  const value = Object.create(inherited)
  const inheritedResult = safeDiagnosticJson(value)
  assert.ok(inheritedResult.length < 128)
  assert.match(inheritedResult, /_truncated/u)
})

test('native diagnostic events omit artifact paths, screen hashes and raw exceptions', () => {
  const hostApplication = readFileSync(
    new URL('../apps/windows-host/HostApplication.cs', import.meta.url),
    'utf8',
  )
  const capturedFrame = readFileSync(
    new URL('../apps/windows-host/Capture/CapturedFrame.cs', import.meta.url),
    'utf8',
  )
  const nativeSession = readFileSync(
    new URL(
      '../apps/windows-host/WebRtc/NativeVideoHostSession.cs',
      import.meta.url,
    ),
    'utf8',
  )

  assert.doesNotMatch(hostApplication, /^\s+path,\s*$|frame\.ContentHash/gmu)
  assert.doesNotMatch(capturedFrame, /ContentHash|FirstFrameHash/u)
  assert.doesNotMatch(nativeSession, /exception\.Message/u)
})

test('packaged browser policy keeps scripts strict and limits socket destinations', () => {
  const index = readFileSync(
    new URL('../apps/web/index.html', import.meta.url),
    'utf8',
  )

  assert.match(index, /http-equiv="Content-Security-Policy"/u)
  assert.match(index, /default-src 'none'/u)
  assert.match(index, /script-src 'self'/u)
  assert.match(index, /script-src-attr 'none'/u)
  assert.match(
    index,
    /connect-src 'self' wss: ws:\/\/127\.0\.0\.1:\* ws:\/\/localhost:\*/u,
  )
  assert.doesNotMatch(index, /script-src 'unsafe-(?:inline|eval)'/u)
})
