import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  sanitizeBrowserTurnDiagnostic,
  sanitizeBrowserTurnText,
} from './browser-turn-simulation.mjs'

const sentinels = {
  sharedSecret: 'ER_BROWSER_TURN_SHARED_SECRET_0123456789',
  username: '1798765432:browser-lab-host-sensitive',
  credential: 'ER_BROWSER_TURN_CREDENTIAL_+/=0123456789',
  token: 'A'.repeat(43),
  code: '907056',
  ipv4: '203.0.113.77',
  ipv6: '2001:db8:85a3::8a2e:370:7334',
  sessionId: 'd9428888-122b-4a13-a0f8-9dd1f1a2b3c4',
  windowsPath: 'C:\\Users\\Sensitive User\\browser-turn\\failure.png',
  posixPath: '/tmp/ediz-remote-browser-turn-sensitive/failure.png',
  fileUrlPath: 'file:///app/scripts/browser-turn-simulation.mjs:42:1',
  sdp: 'v=0\\r\\na=ice-pwd:ER_BROWSER_TURN_ICE_PASSWORD',
  candidate:
    'candidate:ER_BROWSER_TURN_ICE 1 udp 1 203.0.113.77 3478 typ relay',
}

const exactSecrets = [
  sentinels.sharedSecret,
  sentinels.username,
  sentinels.credential,
  '907 056',
]

test('browser TURN text output redacts credentials, network data, IDs and paths', () => {
  const unsafe = [
    `TURN_SHARED_SECRET=${sentinels.sharedSecret}`,
    `username=${sentinels.username}`,
    `credential=${sentinels.credential}`,
    `credential="UNREGISTERED_DYNAMIC_CREDENTIAL"`,
    'child stdout {"credential":"UNREGISTERED_JSON_CREDENTIAL"}',
    `error.message="${sentinels.candidate}"`,
    sentinels.token,
    sentinels.code,
    '907 056',
    sentinels.ipv4,
    sentinels.ipv6,
    sentinels.sessionId,
    sentinels.windowsPath,
    sentinels.posixPath,
    sentinels.sdp,
  ].join('\n')

  const safe = sanitizeBrowserTurnText(unsafe, exactSecrets)
  for (const forbidden of [
    ...Object.values(sentinels),
    'UNREGISTERED_DYNAMIC_CREDENTIAL',
    'UNREGISTERED_JSON_CREDENTIAL',
    'ER_BROWSER_TURN_ICE_PASSWORD',
  ]) {
    assert.equal(safe.includes(forbidden), false, forbidden)
  }
  assert.match(safe, /\[REDACTED/u)
  assert.match(safe, /\[REDACTED_PATH\]/u)
})

test('browser TURN structured diagnostics stay valid JSON without sensitive fields', () => {
  const unsafe = {
    phase: `failed ${sentinels.sharedSecret}`,
    url: `http://${sentinels.ipv4}:8080/session/${sentinels.sessionId}`,
    screenshot: sentinels.windowsPath,
    browser: {
      errorText: `driver ${sentinels.credential}`,
      message: `webdriver ${sentinels.username}`,
    },
    peer: {
      username: sentinels.username,
      credential: sentinels.credential,
      token: sentinels.token,
      sdp: sentinels.sdp,
      candidate: sentinels.candidate,
    },
  }

  const safe = sanitizeBrowserTurnDiagnostic(unsafe, exactSecrets)
  const parsed = JSON.parse(safe)
  for (const forbidden of Object.values(sentinels)) {
    assert.equal(safe.includes(forbidden), false, forbidden)
  }
  assert.equal(parsed.screenshot, '[REDACTED]')
  assert.equal(Object.hasOwn(parsed, 'browser'), false)
  assert.equal(Object.hasOwn(parsed.peer, 'credential'), false)
  assert.equal(parsed.peer._redacted, true)
})

test('browser TURN failure paths cannot bypass the shared safe-output boundary', async () => {
  const source = await readFile(
    new URL('./browser-turn-simulation.mjs', import.meta.url),
    'utf8',
  )

  assert.match(source, /from '\.\/safe-output\.mjs'/u)
  assert.match(source, /stdio: 'pipe'/u)
  assert.doesNotMatch(source, /stdio:\s*options\.capture\s*\?\s*'pipe'\s*:\s*'inherit'/u)
  assert.doesNotMatch(source, /payload\.value\?\.message/u)
  assert.doesNotMatch(source, /markPhase\(`başarısız:/u)
  assert.doesNotMatch(source, /^\s*throw error\s*$/gmu)
  assert.ok(
    source.match(/rememberSensitiveValues\(username, credential\)/gu)?.length >= 2,
  )
  assert.match(source, /sanitizeBrowserTurnDiagnostic\(\{ diagnostics/u)
  assert.match(source, /persisted: false/u)
  assert.match(source, /png\.fill\(0\)/u)
  assert.doesNotMatch(source, /writeFileSync\([^)]*screenshot/iu)
  assert.doesNotMatch(source, /\.png[`'"]/u)
  assert.match(source, /TURN_LOG_OUTPUT=discard/u)
  assert.match(source, /--no-stdout-log/u)
  assert.doesNotMatch(source, /writeFileSync|phaseFile|browser-turn-phase/u)
  assert.match(
    source,
    /function startBrowserContainer[\s\S]*?--log-driver=none[\s\S]*?seleniumImage/u,
  )
  assert.match(source, /`127\.0\.0\.1:\$\{hostPort\}:4444`/u)
  assert.doesNotMatch(source, /`\$\{hostPort\}:4444`/u)
  assert.doesNotMatch(source, /--log-file=stdout/u)
  assert.doesNotMatch(source, /`TURN_SHARED_SECRET=\$\{sharedSecret\}`/u)
  assert.doesNotMatch(source, /'-u',\s*username|'-w',\s*credential/u)
  assert.match(source, /TURN_PROBE_USERNAME:\s*username/u)
  assert.match(source, /process\.once\('SIGTERM'.*terminateWithCleanup/u)
})
