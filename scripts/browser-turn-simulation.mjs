import { createHmac, randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { basename, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  redactSensitiveText,
  safeDiagnosticJson,
} from './safe-output.mjs'

const seleniumImage = 'ediz-remote/selenium-chrome-turn-lab:local'
const coturnImage =
  'coturn/coturn:4.17.0-r0-alpine@sha256:8f80ed9d6867319340ca612b9d005aaea2444755aa4ce3dd79ddfb5f31f6e1b5'
const routerImage =
  'alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce'
const networkA = 'ediz-remote-browser-nat-a'
const networkB = 'ediz-remote-browser-nat-b'
const relayNetwork = 'ediz-remote-browser-relay'
const browserA = 'ediz-remote-browser-a'
const browserB = 'ediz-remote-browser-b'
const routerA = 'ediz-remote-router-a'
const routerB = 'ediz-remote-router-b'
const webdriverPortA = 4444
const webdriverPortB = 4445
const npmCommand =
  process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm'
const npmArguments = (args) =>
  process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args

const exactSensitiveValues = new Set()

let sharedSecret = ''
let appHostAddress = ''
let appOrigin = ''
let appEnvironment

let appProcess
let hostSession
let guestSession
let appOutput = ''
let ownsLabResources = false
let terminationHandled = false

const SENSITIVE_ASSIGNMENT_PATTERN =
  /((?:["']?\b(?:address|candidate|credential|error(?:text)?|ice|ip|message|password|sdp|secret|token|username)\b["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu
const FILE_URL_PATH_PATTERN =
  /file:\/\/\/(?:[A-Za-z]:[\\/]|(?:Users|app|etc|home|tmp|var)\/)[^\s"'<>)]*/giu
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\r\n"'<>|]*/gu
const POSIX_PATH_PATTERN =
  /(^|[\s"'(=])\/(?:Users|app|etc|home|tmp|var)(?:\/[^\s"'<>]*)*/gu

function initializeSimulationState() {
  exactSensitiveValues.clear()
  sharedSecret = randomBytes(32).toString('base64url')
  rememberSensitiveValues(sharedSecret)
  appHostAddress = selectHostIpv4Address()
  appOrigin = `http://${appHostAddress}:8080`
  rememberSensitiveValues(
    appHostAddress,
    appOrigin,
    process.cwd(),
  )
  appEnvironment = {
    ...process.env,
    ICE_STUN_URLS: '',
    TURN_URLS: [
      'turn:9.9.9.10:3478?transport=udp',
      'turn:9.9.9.10:3478?transport=tcp',
    ].join(','),
    TURN_SHARED_SECRET: sharedSecret,
    TURN_CREDENTIAL_TTL_SECONDS: '600',
    VITE_ICE_TRANSPORT_POLICY: 'relay',
    VITE_E2E_DIAGNOSTICS: 'true',
  }
  appProcess = undefined
  hostSession = undefined
  guestSession = undefined
  appOutput = ''
  ownsLabResources = false
}

function rememberSensitiveValues(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 4) {
      exactSensitiveValues.add(value)
    }
  }
}

function allSensitiveValues(additionalSecrets = []) {
  return [...exactSensitiveValues, ...additionalSecrets].filter(
    (value) => typeof value === 'string' && value.length >= 4,
  )
}

export function sanitizeBrowserTurnText(value, additionalSecrets = []) {
  return redactUnsafePathsAndIdentifiers(
    redactSensitiveText(value, allSensitiveValues(additionalSecrets)).replace(
      SENSITIVE_ASSIGNMENT_PATTERN,
      '$1[REDACTED]',
    ),
  )
}

export function sanitizeBrowserTurnDiagnostic(value, additionalSecrets = []) {
  return redactUnsafePathsAndIdentifiers(
    safeDiagnosticJson(value, allSensitiveValues(additionalSecrets)),
  )
}

function redactUnsafePathsAndIdentifiers(value) {
  return String(value)
    .replace(UUID_PATTERN, '[REDACTED_ID]')
    .replace(FILE_URL_PATH_PATTERN, '[REDACTED_PATH]')
    .replace(WINDOWS_PATH_PATTERN, '[REDACTED_PATH]')
    .replace(POSIX_PATH_PATTERN, '$1[REDACTED_PATH]')
}

function safeCommandName(command) {
  const name = basename(String(command ?? ''))
  return /^[A-Za-z0-9._-]{1,64}$/u.test(name) ? name : 'command'
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
    shell: options.shell ?? false,
  })
  const stdout = sanitizeBrowserTurnText(result.stdout ?? '')
  const stderr = sanitizeBrowserTurnText(result.stderr ?? '')
  if (result.status !== 0) {
    const output = `${stdout}${stderr}`
    if (output.trim()) process.stderr.write(output)
    throw new Error(
      `Komut başarısız (${safeCommandName(command)}, durum=${
        Number.isInteger(result.status) ? result.status : 'başlatılamadı'
      }).`,
    )
  }
  if (!options.capture) {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
  }
  return options.capture ? `${stdout}${stderr}` : stdout
}

function ensureLabResourcesAreAbsent() {
  for (const container of [
    browserA,
    browserB,
    routerA,
    routerB,
    'ediz-remote-coturn-acceptance',
  ]) {
    const result = spawnSync('docker', ['container', 'inspect', container], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (result.status === 0) {
      throw new Error(
        `${container} zaten mevcut. Mevcut container'a dokunulmadı; önce durumunu kontrol edin.`,
      )
    }
  }
  for (const network of [networkA, networkB, relayNetwork]) {
    const result = spawnSync('docker', ['network', 'inspect', network], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (result.status === 0) {
      throw new Error(
        `${network} zaten mevcut. Mevcut ağa dokunulmadı; önce durumunu kontrol edin.`,
      )
    }
  }
}

function buildBrowserImage() {
  run('docker', [
    'build',
    '--tag',
    seleniumImage,
    '--file',
    'infra/testing/selenium-chrome/Dockerfile',
    '.',
  ])
}

function startRouter(name, privateNetwork, privateIp, publicIp) {
  run('docker', [
    'create',
    '--name',
    name,
    '--log-driver=none',
    '--network',
    privateNetwork,
    '--ip',
    privateIp,
    '--cap-add',
    'NET_ADMIN',
    '--sysctl',
    'net.ipv4.ip_forward=1',
    '--entrypoint',
    '/bin/sh',
    routerImage,
    '-c',
    'apk add --no-cache iptables >/dev/null && iptables -t nat -A POSTROUTING -o eth1 -j MASQUERADE && iptables -A FORWARD -i eth0 -o eth1 -j ACCEPT && iptables -A FORWARD -i eth1 -o eth0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT && tail -f /dev/null',
  ])
  run('docker', [
    'network',
    'connect',
    '--ip',
    publicIp,
    relayNetwork,
    name,
  ])
  run('docker', ['start', name])
}

async function waitForRouter(name) {
  await waitFor(
    `${name} NAT yönlendiricisi`,
    () => {
      const result = spawnSync(
        'docker',
        [
          'exec',
          name,
          'iptables',
          '-t',
          'nat',
          '-C',
          'POSTROUTING',
          '-o',
          'eth1',
          '-j',
          'MASQUERADE',
        ],
        { stdio: 'ignore', timeout: 3_000, windowsHide: true },
      )
      return result.status === 0
    },
    (ready) => ready,
    30_000,
  )
}

function startCoturnContainer() {
  const entrypoint = join(process.cwd(), 'infra', 'coturn', 'entrypoint.sh')
  run('docker', [
    'create',
    '--name',
    'ediz-remote-coturn-acceptance',
    '--log-driver=none',
    '--network',
    relayNetwork,
    '--ip',
    '9.9.9.10',
    '--network-alias',
    'turn.browser.test',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_BIND_SERVICE',
    '--tmpfs',
    '/tmp:size=4m,mode=0700,uid=65534,gid=65534',
    '--tmpfs',
    '/var/lib/coturn:size=16m,mode=0700,uid=65534,gid=65534',
    '-e',
    'TURN_SHARED_SECRET',
    '-e',
    'TURN_REALM=relay.browser-lab',
    '-e',
    'TURN_TEST_MODE=true',
    '-e',
    'TURN_LOG_OUTPUT=discard',
    '-e',
    'TURN_ALLOW_PRIVATE_PEERS=true',
    '-e',
    'TURN_LOG_LEVEL=debug',
    '-e',
    'TURN_MIN_PORT=49160',
    '-e',
    'TURN_MAX_PORT=49200',
    '-v',
    `${entrypoint}:/etc/ediz-remote/entrypoint.sh:ro`,
    '--entrypoint',
    '/bin/sh',
    coturnImage,
    '/etc/ediz-remote/entrypoint.sh',
  ], {
    env: { ...process.env, TURN_SHARED_SECRET: sharedSecret },
  })
  run('docker', ['start', 'ediz-remote-coturn-acceptance'])
}

function switchToIsolatedBrowserCoturn() {
  run('docker', ['rm', '-f', 'ediz-remote-coturn-acceptance'])
  run('docker', [
    'run',
    '-d',
    '--name',
    'ediz-remote-coturn-acceptance',
    '--log-driver=none',
    '--network',
    relayNetwork,
    '--ip',
    '9.9.9.10',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_BIND_SERVICE',
    '--tmpfs',
    '/tmp:size=4m,mode=0700,uid=65534,gid=65534',
    '--tmpfs',
    '/var/lib/coturn:size=16m,mode=0700,uid=65534,gid=65534',
    '--entrypoint',
    'turnserver',
    coturnImage,
    '-n',
    '--no-auth',
    '--realm=relay.browser-lab',
    '--server-name=relay.browser-lab',
    '--listening-port=3478',
    '--min-port=49160',
    '--max-port=49200',
    '--no-cli',
    '--no-tls',
    '--no-dtls',
    '--no-tcp-relay',
    '--no-multicast-peers',
    '--no-rfc5780',
    '--pidfile=/tmp/turnserver.pid',
    '--no-stdout-log',
    '--log-file=/dev/null',
    '--simple-log',
  ])
}

async function waitForCoturn() {
  await waitFor(
    'İki ağlı coturn',
    () => {
      const result = spawnSync(
        'docker',
        [
          'exec',
          'ediz-remote-coturn-acceptance',
          'sh',
          '-c',
          'test -s /tmp/turnserver.pid && kill -0 "$(cat /tmp/turnserver.pid)"',
        ],
        {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 3_000,
          windowsHide: true,
        },
      )
      return result.status === 0
    },
    (ready) => ready,
    30_000,
  )
}

async function probeCoturnFromNetwork(network, label) {
  const expiresAt = Math.floor(Date.now() / 1_000) + 600
  const username = `${expiresAt}:browser-lab-${label}`
  const credential = createHmac('sha1', sharedSecret)
    .update(username)
    .digest('base64')
  rememberSensitiveValues(username, credential)
  const argumentsList = [
      'run',
      '--rm',
      '--log-driver=none',
      '--network',
      relayNetwork,
      '-e',
      'TURN_PROBE_USERNAME',
      '-e',
      'TURN_PROBE_CREDENTIAL',
      '--entrypoint',
      '/bin/sh',
      coturnImage,
      '-c',
      'exec turnutils_uclient -y -c -n 1 -u "$TURN_PROBE_USERNAME" -w "$TURN_PROBE_CREDENTIAL" turn.browser.test',
    ]
  await waitFor(
    `${label} sanal ağı coturn relay probe`,
    () => {
      const result = spawnSync('docker', argumentsList, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TURN_PROBE_USERNAME: username,
          TURN_PROBE_CREDENTIAL: credential,
        },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 15_000,
        windowsHide: true,
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      return {
        status: result.status,
        passed: /tot_send_msgs=2,\s+tot_recv_msgs=2/.test(output),
      }
    },
    (result) => result.status === 0 && result.passed,
    20_000,
  )
}

function startApplication() {
  appProcess = spawn(npmCommand, npmArguments(['run', 'dev']), {
    cwd: process.cwd(),
    env: appEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const collect = (chunk) => {
    appOutput = `${appOutput}${chunk.toString()}`.slice(-200_000)
  }
  appProcess.stdout.on('data', collect)
  appProcess.stderr.on('data', collect)
  appProcess.on('error', () => {
    appOutput = `${appOutput}\n[APP_PROCESS_ERROR]\n`.slice(-200_000)
  })
}

function startBrowserContainer(name, network, hostPort) {
  run('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--log-driver=none',
    '--network',
    network,
    '--shm-size=1g',
    '--cap-add',
    'NET_ADMIN',
    '-p',
    `127.0.0.1:${hostPort}:4444`,
    '-e',
    'SE_NODE_SESSION_TIMEOUT=180',
    seleniumImage,
  ])
}

function addTurnRoute(browser, routerIp) {
  run('docker', [
    'exec',
    '--user',
    'root',
    browser,
    'ip',
    'route',
    'replace',
    '9.9.9.0/24',
    'via',
    routerIp,
  ])
}

async function createBrowserSession(port) {
  const value = await webdriver(port, '/session', {
    method: 'POST',
    body: {
      capabilities: {
        alwaysMatch: {
          browserName: 'chrome',
          'goog:chromeOptions': {
            args: [
              '--no-sandbox',
              '--disable-dev-shm-usage',
              '--use-fake-ui-for-media-stream',
              '--use-fake-device-for-media-stream',
              '--enable-usermedia-screen-capturing',
              '--allow-http-screen-capture',
              '--auto-select-desktop-capture-source=Entire screen',
              `--unsafely-treat-insecure-origin-as-secure=${appOrigin}`,
              '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC',
              `--ip-address-space-overrides=${appHostAddress}:8080=local,9.9.9.0/24=public`,
              '--force-webrtc-ip-handling-policy=default',
              '--window-size=1280,900',
            ],
          },
          'goog:loggingPrefs': { browser: 'ALL' },
        },
      },
    },
  })
  rememberSensitiveValues(value.sessionId)
  return { port, id: value.sessionId }
}

async function webdriver(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeout ?? 8_000),
  })
  const payload = await response.json()
  if (!response.ok || payload.value?.error) {
    const operation = safeWebdriverOperation(path, options.method)
    const driverCode = safeWebdriverErrorCode(payload.value?.error)
    throw new Error(
      `WebDriver işlemi başarısız (${operation}, ${driverCode}, HTTP ${response.status}).`,
    )
  }
  return payload.value
}

function safeWebdriverOperation(path, method = 'GET') {
  if (path === '/status') return 'status'
  if (path === '/session') return 'session_create'
  if (/^\/session\/[^/]+$/u.test(path) && method === 'DELETE') {
    return 'session_delete'
  }
  const finalSegment = path.split('/').filter(Boolean).at(-1)
  const allowed = new Set([
    'async',
    'click',
    'element',
    'log',
    'screenshot',
    'sync',
    'url',
    'value',
  ])
  return finalSegment && allowed.has(finalSegment)
    ? `session_${finalSegment}`
    : 'request'
}

function safeWebdriverErrorCode(value) {
  if (typeof value !== 'string') return 'http_error'
  const normalized = value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/gu, '_')
  const allowed = new Set([
    'element_click_intercepted',
    'invalid_argument',
    'invalid_session_id',
    'javascript_error',
    'no_such_element',
    'session_not_created',
    'stale_element_reference',
    'timeout',
    'unknown_error',
  ])
  return allowed.has(normalized) ? normalized : 'driver_error'
}

async function sessionRequest(session, path, options = {}) {
  return webdriver(session.port, `/session/${session.id}${path}`, options)
}

async function navigate(session, url) {
  await sessionRequest(session, '/url', {
    method: 'POST',
    body: { url },
    timeout: 30_000,
  })
}

async function execute(session, script, args = []) {
  return sessionRequest(session, '/execute/sync', {
    method: 'POST',
    body: { script, args },
  })
}

async function executeAsync(session, script, args = []) {
  return sessionRequest(session, '/execute/async', {
    method: 'POST',
    body: { script, args },
    timeout: 20_000,
  })
}

async function probeBrowserTurnIce(session, turnUrl, label) {
  const expiresAt = Math.floor(Date.now() / 1_000) + 600
  const username = `${expiresAt}:browser-ice-${label}`
  const credential = createHmac('sha1', sharedSecret)
    .update(username)
    .digest('base64')
  rememberSensitiveValues(username, credential)
  const result = await executeAsync(
    session,
    `
      const [url, username, credential, done] = arguments;
      const peer = new RTCPeerConnection({
        iceServers: [{
          urls: [url],
          username,
          credential,
          credentialType: 'password',
        }],
        iceTransportPolicy: 'relay',
      });
      const candidates = [];
      const errors = [];
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        const value = {
          candidates,
          errors,
          gatheringState: peer.iceGatheringState,
        };
        peer.close();
        done(value);
      };
      peer.addEventListener('icecandidate', (event) => {
        if (!event.candidate) return;
        const fields = event.candidate.candidate.trim().split(/\\s+/);
        const typeIndex = fields.indexOf('typ');
        candidates.push({
          protocol: fields[2]?.toLowerCase() ?? 'unknown',
          type: typeIndex >= 0 ? fields[typeIndex + 1] : 'unknown',
        });
      });
      peer.addEventListener('icecandidateerror', (event) => {
        errors.push({ code: event.errorCode, errorText: event.errorText });
      });
      peer.addEventListener('icegatheringstatechange', () => {
        if (peer.iceGatheringState === 'complete') finish();
      });
      peer.addTransceiver('audio', { direction: 'recvonly' });
      peer.createOffer()
        .then((offer) => peer.setLocalDescription(offer))
        .catch((error) => errors.push({ code: 0, errorText: error.message }));
      setTimeout(finish, 12_000);
    `,
    [turnUrl, username, credential],
  )
  if (!result.candidates.some((candidate) => candidate.type === 'relay')) {
    const networkProbe = await executeAsync(
      session,
      `
        const [url, done] = arguments;
        const peer = new RTCPeerConnection({ iceServers: [{ urls: [url] }] });
        const candidates = [];
        let completed = false;
        const finish = () => {
          if (completed) return;
          completed = true;
          const value = { candidates, gatheringState: peer.iceGatheringState };
          peer.close();
          done(value);
        };
        peer.addEventListener('icecandidate', (event) => {
          if (!event.candidate) return;
          const fields = event.candidate.candidate.trim().split(/\\s+/);
          const typeIndex = fields.indexOf('typ');
          candidates.push({
            protocol: fields[2]?.toLowerCase() ?? 'unknown',
            type: typeIndex >= 0 ? fields[typeIndex + 1] : 'unknown',
          });
        });
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') finish();
        });
        peer.addTransceiver('audio', { direction: 'recvonly' });
        peer.createOffer()
          .then((offer) => peer.setLocalDescription(offer))
          .catch(() => finish());
        setTimeout(finish, 6_000);
      `,
      [turnUrl.replace(/^turn:/, 'stun:').replace(/\?transport=.*$/, '')],
    )
    throw new Error(
      `${sanitizeBrowserTurnText(label)} Chrome TURN ICE probe relay adayı üretmedi: ${sanitizeBrowserTurnDiagnostic({ turn: result, network: networkProbe })}`,
    )
  }
  return result
}

async function findElement(session, using, value) {
  const element = await sessionRequest(session, '/element', {
    method: 'POST',
    body: { using, value },
  })
  return element['element-6066-11e4-a52e-4f735466cecf']
}

async function clickElement(session, using, value) {
  const elementId = await findElement(session, using, value)
  await sessionRequest(session, `/element/${elementId}/click`, {
    method: 'POST',
    body: {},
  })
}

async function typeIntoElement(session, selector, text) {
  const elementId = await findElement(session, 'css selector', selector)
  await sessionRequest(session, `/element/${elementId}/value`, {
    method: 'POST',
    body: { text, value: [...text] },
  })
}

async function readActivity(session) {
  return execute(
    session,
    "return document.querySelector('[data-testid=\"connection-activity\"]')?.textContent?.trim() ?? '';",
  )
}

async function waitFor(label, probe, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let lastValue
  let lastError
  while (Date.now() < deadline) {
    try {
      lastValue = await probe()
      if (predicate(lastValue)) return lastValue
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    await delay(400)
  }
  const diagnostic = sanitizeBrowserTurnDiagnostic({
    lastValue,
    probeFailed: Boolean(lastError),
  })
  throw new Error(
    `${sanitizeBrowserTurnText(label)} zaman aşımı. Tanı: ${diagnostic}`,
  )
}

async function waitForWebdriver(port) {
  await waitFor(
    `Selenium ${port}`,
    () => webdriver(port, '/status', { timeout: 3_000 }),
    (status) =>
      status?.ready === true ||
      status?.nodes?.some((node) => node.availability === 'UP'),
    60_000,
  )
}

async function waitForApplication() {
  await waitFor(
    'Yerel web/signaling',
    async () => {
      const response = await fetch('http://127.0.0.1:8080/health', {
        signal: AbortSignal.timeout(2_000),
      })
      return response.ok ? response.text() : ''
    },
    (value) => value.includes('"status":"ok"'),
    45_000,
  )
}

async function waitForActivity(session, expected, timeout = 30_000) {
  return waitFor(
    `Aktivite '${expected}'`,
    () => readActivity(session),
    (activity) => activity.includes(expected),
    timeout,
  )
}

async function captureScreenshot(session) {
  const base64 = await sessionRequest(session, '/screenshot')
  if (
    typeof base64 !== 'string' ||
    base64.length === 0 ||
    base64.length > 32 * 1024 * 1024
  ) {
    throw new Error('Browser ekran kanıtı güvenli sınırın dışında.')
  }
  const png = Buffer.from(base64, 'base64')
  try {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (png.length < pngSignature.length || !png.subarray(0, 8).equals(pngSignature)) {
      throw new Error('Browser ekran kanıtı PNG biçiminde değil.')
    }
    return { bytes: png.length, persisted: false }
  } finally {
    png.fill(0)
  }
}

async function readRelevantBrowserLogs(session) {
  const entries = await sessionRequest(session, '/se/log', {
    method: 'POST',
    body: { type: 'browser' },
  })
  return entries.filter((entry) =>
    ['SEVERE', 'WARNING'].includes(String(entry.level).toUpperCase()),
  )
}

async function disconnectAndReconnectGuestNetwork() {
  run('docker', ['network', 'disconnect', networkB, browserB])
  await delay(5_000)
  run('docker', ['network', 'connect', networkB, browserB])
  addTurnRoute(browserB, '172.28.20.254')
  await waitForWebdriver(webdriverPortB)
}

async function closeSession(session) {
  if (!session) return
  try {
    await webdriver(session.port, `/session/${session.id}`, {
      method: 'DELETE',
      timeout: 5_000,
    })
  } catch {
    // Container kapanırken oturum zaten sonlanmış olabilir.
  }
}

function stopApplication() {
  if (!appProcess || appProcess.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(appProcess.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    appProcess.kill('SIGTERM')
  }
}

function cleanupDocker() {
  for (const container of [
    browserA,
    browserB,
    routerA,
    routerB,
    'ediz-remote-coturn-acceptance',
  ]) {
    spawnSync('docker', ['rm', '-f', container], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15_000,
    })
  }
  for (const network of [networkA, networkB, relayNetwork]) {
    spawnSync('docker', ['network', 'rm', network], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    })
  }
}

function terminateWithCleanup(exitCode) {
  if (terminationHandled) return
  terminationHandled = true
  stopApplication()
  if (ownsLabResources) cleanupDocker()
  process.exit(exitCode)
}

function selectHostIpv4Address() {
  const override = process.env.TURN_BROWSER_SIMULATION_HOST?.trim()
  if (override) return override

  const candidates = Object.values(networkInterfaces())
    .flat()
    .filter(
      (address) =>
        address &&
        address.family === 'IPv4' &&
        !address.internal &&
        !address.address.startsWith('169.254.'),
    )
    .map((address) => address.address)

  const selected =
    candidates.find((address) => address.startsWith('192.168.1.')) ??
    candidates.find((address) => address.startsWith('192.168.')) ??
    candidates.find((address) => address.startsWith('10.')) ??
    candidates[0]
  if (!selected) {
    throw new Error('Sanal browser TURN laboratuvarı için host IPv4 bulunamadı.')
  }
  return selected
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function markPhase(value) {
  process.stdout.write(
    `${sanitizeBrowserTurnText(`Browser TURN fazı: ${value}.`)}\n`,
  )
}

async function runBrowserTurnSimulation() {
  try {
    initializeSimulationState()
    markPhase('başlıyor')
  ensureLabResourcesAreAbsent()
  ownsLabResources = true
  buildBrowserImage()
  run(
    npmCommand,
    npmArguments(['run', 'build', '--workspace', '@ediz-remote/protocol']),
  )
  run(
    npmCommand,
    npmArguments(['run', 'build', '--workspace', '@ediz-remote/signaling']),
  )
  run('docker', ['network', 'create', '--subnet', '172.28.10.0/24', networkA])
  run('docker', ['network', 'create', '--subnet', '172.28.20.0/24', networkB])
  run('docker', ['network', 'create', '--subnet', '9.9.9.0/24', relayNetwork])
  startRouter(routerA, networkA, '172.28.10.254', '9.9.9.101')
  startRouter(routerB, networkB, '172.28.20.254', '9.9.9.102')
  await Promise.all([waitForRouter(routerA), waitForRouter(routerB)])
  markPhase('iki NAT yönlendiricisi hazır')
  startCoturnContainer()
  await waitForCoturn()
  markPhase('coturn hazır')
  await Promise.all([
    probeCoturnFromNetwork(networkA, 'host'),
    probeCoturnFromNetwork(networkB, 'guest'),
  ])
  markPhase('iki ağ HMAC relay probe geçti')
  switchToIsolatedBrowserCoturn()
  await waitForCoturn()
  markPhase('izole browser coturn hazır')
  startBrowserContainer(browserA, networkA, webdriverPortA)
  startBrowserContainer(browserB, networkB, webdriverPortB)
  addTurnRoute(browserA, '172.28.10.254')
  addTurnRoute(browserB, '172.28.20.254')
  startApplication()

  await Promise.all([
    waitForWebdriver(webdriverPortA),
    waitForWebdriver(webdriverPortB),
    waitForApplication(),
  ])
  markPhase('uygulama ve selenium hazır')

  hostSession = await createBrowserSession(webdriverPortA)
  guestSession = await createBrowserSession(webdriverPortB)
  await Promise.all([
    navigate(hostSession, appOrigin),
    navigate(guestSession, appOrigin),
  ])
  markPhase('iki browser sayfayı açtı')

  await Promise.all([
    probeBrowserTurnIce(
      hostSession,
      'turn:9.9.9.10:3478?transport=udp',
      'host',
    ),
    probeBrowserTurnIce(
      guestSession,
      'turn:9.9.9.10:3478?transport=udp',
      'guest',
    ),
  ])
  markPhase('iki Chrome relay ICE adayı üretti')

  await Promise.all(
    [hostSession, guestSession].map((session) =>
      waitFor(
        'Sinyalleşme bağlantısı',
        () =>
          execute(
            session,
            "return document.querySelector('[role=\"status\"]')?.textContent?.trim() ?? '';",
          ),
        (value) => value.includes('Sinyalleşme servisi bağlı'),
      ),
    ),
  )
  markPhase('iki browser signaling bağlı')
  const connectionCode = await waitFor(
    'Altı haneli host kodu',
    () =>
      execute(
        hostSession,
        "return (document.querySelector('.session-code strong')?.textContent ?? '').replace(/\\D/g, '');",
      ),
    (value) => /^\d{6}$/.test(value),
  )
  rememberSensitiveValues(
    connectionCode,
    `${connectionCode.slice(0, 3)} ${connectionCode.slice(3)}`,
  )

  await typeIntoElement(guestSession, '#join-code', connectionCode)
  await clickElement(
    guestSession,
    'xpath',
    "//button[normalize-space(.)='Bağlan']",
  )
  markPhase('host yalnızca görüntüleme onayı verdi')
  await waitFor(
    'Host onay diyaloğu',
    () =>
      execute(
        hostSession,
        "return document.querySelector('[role=\"dialog\"]')?.textContent ?? '';",
      ),
    (value) => value.includes('Bağlantı isteği'),
  )
  await clickElement(
    hostSession,
    'xpath',
    "//button[normalize-space(.)='Yalnızca görüntüle']",
  )

  const [hostRelayActivity, guestRelayActivity] = await Promise.all([
    waitForActivity(hostSession, 'TURN relay bağlantısı', 30_000),
    waitForActivity(guestSession, 'TURN relay bağlantısı', 30_000),
  ])
  markPhase('iki browser TURN relay bağlı')

  await execute(
    hostSession,
    "const original=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getDisplayMedia=async (...args)=>{try{return await original(...args)}catch(error){window.__edizScreenShareError={name:error?.name ?? '',message:error?.message ?? ''};throw error}}; return true;",
  )
  await clickElement(hostSession, 'css selector', '[data-testid="screen-share-button"]')
  await waitForActivity(hostSession, 'Ekran paylaşımı açık', 20_000)
  const videoState = await waitFor(
    'Guest uzak video',
    () =>
      execute(
        guestSession,
        "const video=document.querySelector('[data-testid=\"remote-video\"]'); return video ? {readyState:video.readyState,width:video.videoWidth,height:video.videoHeight,currentTime:video.currentTime} : null;",
      ),
    (value) => value?.readyState >= 2 && value.width > 0 && value.height > 0,
    30_000,
  )
  markPhase('guest ekran videosunu aldı')

  const beforeInterruptionScreenshot = await captureScreenshot(guestSession)

  await disconnectAndReconnectGuestNetwork()
  markPhase('guest ağı kesilip geri bağlandı')
  const [recoveredGuestActivity, recoveredHostActivity] = await Promise.all([
    waitForActivity(guestSession, 'TURN relay bağlantısı', 40_000),
    waitForActivity(hostSession, 'TURN relay bağlantısı', 40_000),
  ])
  const recoveredVideoState = await waitFor(
    'Kesinti sonrası guest video',
    () =>
      execute(
        guestSession,
        "const video=document.querySelector('[data-testid=\"remote-video\"]'); return video ? {readyState:video.readyState,width:video.videoWidth,height:video.videoHeight,currentTime:video.currentTime} : null;",
      ),
    (value) =>
      value?.readyState >= 2 &&
      value.width > 0 &&
      value.height > 0 &&
      value.currentTime > videoState.currentTime + 0.25,
    30_000,
  )
  markPhase('relay ve video kesinti sonrası döndü')

  const afterInterruptionScreenshot = await captureScreenshot(guestSession)
  const [hostLogs, guestLogs] = await Promise.all([
    readRelevantBrowserLogs(hostSession),
    readRelevantBrowserLogs(guestSession),
  ])
    if (hostLogs.length > 0 || guestLogs.length > 0) {
      process.stderr.write(
        `\nBrowser console tanısı: ${sanitizeBrowserTurnDiagnostic({ hostLogs, guestLogs })}\n`,
      )
      throw new Error('Browser warning/error bulundu (browser_console_error).')
    }

    process.stdout.write(
      [
        'İki sanal NAT browser TURN simülasyonu başarılı.',
        `Host özel ağı: ${networkA}.`,
        `Guest özel ağı: ${networkB}.`,
        `Ortak TURN omurgası: ${relayNetwork}; ICE politikası relay-only.`,
        'Üretim HMAC credential hattı resmi coturn istemcileriyle doğrulandı; browser medya ayağı kapalı laboratuvarda no-auth coturn ile ayrıştırıldı.',
        `İlk host durumu: ${sanitizeBrowserTurnText(hostRelayActivity)}`,
        `İlk guest durumu: ${sanitizeBrowserTurnText(guestRelayActivity)}`,
        `İlk video: ${videoState.width}x${videoState.height}, readyState=${videoState.readyState}, currentTime=${videoState.currentTime.toFixed(2)}.`,
        `Kesinti sonrası host: ${sanitizeBrowserTurnText(recoveredHostActivity)}`,
        `Kesinti sonrası guest: ${sanitizeBrowserTurnText(recoveredGuestActivity)}`,
        `Kesinti sonrası video: ${recoveredVideoState.width}x${recoveredVideoState.height}, readyState=${recoveredVideoState.readyState}, currentTime=${recoveredVideoState.currentTime.toFixed(2)}.`,
        'Browser console: 0 warning/error.',
        `Ekran kanıtı (önce): bellekte doğrulandı, ${beforeInterruptionScreenshot.bytes} bayt; diske yazılmadı.`,
        `Ekran kanıtı (sonra): bellekte doğrulandı, ${afterInterruptionScreenshot.bytes} bayt; diske yazılmadı.`,
      ].join('\n') + '\n',
    )
  } catch {
    markPhase('başarısız')
    try {
      if (!ownsLabResources) throw new Error('lab_not_owned')
      const turnLogs = run(
        'docker',
        ['logs', '--tail', '200', 'ediz-remote-coturn-acceptance'],
        { capture: true, timeout: 10_000 },
      )
      if (turnLogs.trim()) {
        process.stderr.write(
          `\nCoturn son kayıtları:\n${sanitizeBrowserTurnText(turnLogs)}\n`,
        )
      }
    } catch {
      // Ana test hatası korunur.
    }
    await Promise.all(
      [
        ['host', hostSession],
        ['guest', guestSession],
      ].map(async ([label, session]) => {
        if (!session) return
        try {
          const diagnostics = await execute(
            session,
            "return {url:location.href,title:document.title,status:document.querySelector('[role=\"status\"]')?.textContent?.trim() ?? '',activity:document.querySelector('[data-testid=\"connection-activity\"]')?.textContent?.trim() ?? '',alert:document.querySelector('[role=\"alert\"]')?.textContent?.trim() ?? '',peer:window.__edizRemotePeerDiagnostics ?? null,screenShareError:window.__edizScreenShareError ?? null};",
          )
          const screenshot = await captureScreenshot(session)
          process.stderr.write(
            `\n${label} browser tanısı: ${sanitizeBrowserTurnDiagnostic({ diagnostics, screenshot })}\n`,
          )
        } catch {
          // Oturum erişilemiyorsa mevcut ana hata korunur.
        }
      }),
    )
    try {
      if (!ownsLabResources) throw new Error('lab_not_owned')
      const coturnLogs = run(
        'docker',
        ['logs', '--tail', '160', 'ediz-remote-coturn-acceptance'],
        { capture: true, timeout: 10_000 },
      )
      if (coturnLogs.trim()) {
        process.stderr.write(
          `\ncoturn son çıktısı:\n${sanitizeBrowserTurnText(coturnLogs)}\n`,
        )
      }
    } catch {
      // Coturn başlamadıysa log olmayabilir.
    }
    const safeOutput = sanitizeBrowserTurnText(appOutput)
    if (safeOutput.trim()) {
      process.stderr.write(`\nUygulama son çıktısı:\n${safeOutput}\n`)
    }
    process.stderr.write(
      '\nBrowser TURN simülasyonu başarısız (browser_turn_simulation_failed).\n',
    )
    process.exitCode = 1
  } finally {
    markPhase('temizlik başladı')
    await Promise.all([closeSession(hostSession), closeSession(guestSession)])
    stopApplication()
    if (ownsLabResources) cleanupDocker()
    markPhase('temizlik tamamlandı')
  }
}

const directEntryPath = process.argv[1]
if (
  directEntryPath &&
  import.meta.url === pathToFileURL(directEntryPath).href
) {
  process.once('SIGINT', () => terminateWithCleanup(130))
  process.once('SIGTERM', () => terminateWithCleanup(143))
  await runBrowserTurnSimulation()
}
