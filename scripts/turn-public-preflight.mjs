import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import {
  createIceConfiguration,
  loadIceServiceOptions,
} from '../services/signaling/dist/ice.js'
import {
  parseBoundedInteger,
  parseRelayCounters,
  parseTurnEndpoint,
  validateRelayCounters,
} from './turn-preflight-lib.mjs'
import { redactSensitiveText } from './safe-output.mjs'

try {
  await runPublicPreflight()
} catch {
  process.stderr.write(
    `${redactSensitiveText('turn_public_preflight_failed')}\n`,
  )
  process.exitCode = 1
}

async function runPublicPreflight() {
  const image =
    process.env.TURN_PREFLIGHT_DOCKER_IMAGE?.trim() ||
    'coturn/coturn:4.17.0-r0-alpine@sha256:8f80ed9d6867319340ca612b9d005aaea2444755aa4ce3dd79ddfb5f31f6e1b5'
  const hostOverride = process.env.TURN_PREFLIGHT_HOST?.trim()
  const skipHostChecks = process.env.TURN_PREFLIGHT_SKIP_HOST_CHECKS === 'true'
  const messageRounds = parseBoundedInteger(
    process.env.TURN_PREFLIGHT_MESSAGE_ROUNDS,
    3,
    1,
    50,
    'TURN_PREFLIGHT_MESSAGE_ROUNDS',
  )
  const minimumDeliveryPercent = parseBoundedInteger(
    process.env.TURN_PREFLIGHT_MIN_DELIVERY_PERCENT,
    95,
    1,
    100,
    'TURN_PREFLIGHT_MIN_DELIVERY_PERCENT',
  )

  const options = loadIceServiceOptions(process.env)
  if (options.turnUrls.length === 0 || !options.turnSharedSecret) {
    throw new Error(
      'Public preflight için TURN_URLS ve TURN_SHARED_SECRET gereklidir.',
    )
  }

  const endpoints = options.turnUrls.map(parseTurnEndpoint)
  if (endpoints.some((endpoint) => endpoint.secure)) {
    throw new Error(
      'Bu preflight yalnızca mevcut turn: UDP/TCP deployment hattını destekler; turns: henüz etkin değildir.',
    )
  }

  const configuration = createIceConfiguration(
    `public-preflight-${randomBytes(8).toString('hex')}`,
    Date.now(),
    options,
  )
  const turnServer = configuration.iceServers.find((server) => server.username)
  if (!turnServer?.username || !turnServer.credential) {
    throw new Error(
      'Public preflight için kısa ömürlü TURN credential üretilemedi.',
    )
  }

  const results = []
  for (const endpoint of endpoints) {
    const targetHost = hostOverride || endpoint.host
    if (!skipHostChecks) {
      await verifyHost(targetHost, endpoint.port, endpoint.transport)
    }
    results.push(
      runTurnutilsProbe(
        targetHost,
        endpoint.port,
        endpoint.transport,
        turnServer.username,
        turnServer.credential,
        { image, messageRounds, minimumDeliveryPercent },
      ),
    )
  }

  process.stdout.write(`${redactSensitiveText(
    [
      'Public TURN preflight başarılı.',
      `Credential geçerlilik sonu: ${configuration.expiresAt}`,
      ...results.map(
        (result, index) =>
          `${result.transport.toUpperCase()} endpoint ${index + 1}: ` +
          `${result.received}/${result.sent} (%${result.deliveryPercent.toFixed(1)}).`,
      ),
    ].join('\n'),
    [
      process.env.TURN_URLS,
      options.turnSharedSecret,
      hostOverride,
      turnServer.username,
      turnServer.credential,
      ...options.turnUrls,
    ],
  )}\n`)
}

async function verifyHost(host, port, transport) {
  let addresses
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new Error(redactSensitiveText('TURN hedefi DNS ile çözümlenemedi.'))
  }
  if (addresses.length === 0) {
    throw new Error(redactSensitiveText('TURN hedefi DNS çözümlemesi sonuç vermedi.'))
  }
  if (transport === 'tcp') {
    await verifyTcpListener(host, port)
  }
}

function verifyTcpListener(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(redactSensitiveText('TURN TCP listener zaman aşımına uğradı.')))
    }, 5_000)

    socket.once('connect', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve()
    })
    socket.once('error', () => {
      clearTimeout(timeout)
      reject(new Error(redactSensitiveText("TURN TCP listener'a bağlanılamadı.")))
    })
  })
}

function runTurnutilsProbe(
  host,
  port,
  transport,
  username,
  credential,
  { image, messageRounds, minimumDeliveryPercent },
) {
  const argumentsList = [
    'run',
    '--rm',
    '--log-driver=none',
    '-e',
    'TURN_PROBE_USERNAME',
    '-e',
    'TURN_PROBE_CREDENTIAL',
    '-e',
    'TURN_PROBE_HOST',
    '-e',
    'TURN_PROBE_PORT',
    '--entrypoint',
    '/bin/sh',
    image,
    '-c',
    [
      'exec turnutils_uclient',
      transport === 'tcp' ? '-t' : '',
      '-y -c',
      `-n ${messageRounds}`,
      '-u "$TURN_PROBE_USERNAME"',
      '-w "$TURN_PROBE_CREDENTIAL"',
      '-p "$TURN_PROBE_PORT"',
      '"$TURN_PROBE_HOST"',
    ].filter(Boolean).join(' '),
  ]
  const result = spawnSync('docker', argumentsList, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TURN_PROBE_USERNAME: username,
      TURN_PROBE_CREDENTIAL: credential,
      TURN_PROBE_HOST: host,
      TURN_PROBE_PORT: String(port),
    },
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) {
    throw new Error(
      redactSensitiveText(
        `${transport.toUpperCase()} TURN probe başarısız oldu (exit ${result.status}).`,
        [host, username, credential, process.env.TURN_URLS],
      ),
    )
  }

  const counters = parseRelayCounters(output)
  validateRelayCounters(
    counters,
    messageRounds * 2,
    minimumDeliveryPercent,
  )
  return { transport, ...counters }
}
