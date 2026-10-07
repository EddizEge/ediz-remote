import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createIceConfiguration } from '../services/signaling/dist/ice.js'
import { redactSensitiveText } from './safe-output.mjs'

const composeFile = 'infra/coturn/compose.test.yml'
const networkToolsImage =
  'debian:13-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132'
const sharedSecret = randomBytes(32).toString('base64url')
const environment = { ...process.env, TURN_SHARED_SECRET: sharedSecret }

function run(command, args, additionalEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...environment, ...additionalEnvironment },
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120_000,
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(redactSensitiveText('Ağ kalite yardımcı işlemi başarısız oldu.'))
  }
  return result.stdout ?? ''
}

function compose(args, additionalEnvironment = {}) {
  return run(
    'docker',
    ['compose', '-f', composeFile, ...args],
    additionalEnvironment,
  )
}

function createCredential() {
  const configuration = createIceConfiguration('network-quality-probe', Date.now(), {
    stunUrls: ['stun:coturn:3478'],
    turnUrls: [
      'turn:coturn:3478?transport=udp',
      'turn:coturn:3478?transport=tcp',
    ],
    turnSharedSecret: sharedSecret,
    turnCredentialTtlSeconds: 600,
  })
  const server = configuration.iceServers.find((entry) => entry.username)
  if (!server?.username || !server.credential) {
    throw new Error('Ağ kalite probu için TURN credential üretilemedi.')
  }
  return server
}

function runRelayProbe(label, credential, extraArguments) {
  const startedAt = Date.now()
  const output = compose(
    [
      'run',
      '--rm',
      '-e',
      'TURN_PROBE_USERNAME',
      '-e',
      'TURN_PROBE_CREDENTIAL',
      '--entrypoint',
      '/bin/sh',
      'turn-probe',
      '-c',
      [
        'exec turnutils_uclient',
        ...extraArguments,
        '-u "$TURN_PROBE_USERNAME"',
        '-w "$TURN_PROBE_CREDENTIAL"',
        'coturn',
      ].join(' '),
    ],
    {
      TURN_PROBE_USERNAME: credential.username,
      TURN_PROBE_CREDENTIAL: credential.credential,
    },
  )
  const counterMatches = [
    ...output.matchAll(/tot_send_msgs=(\d+),\s+tot_recv_msgs=(\d+)/g),
  ]
  const counters = counterMatches.at(-1)
  if (!counters) {
    throw new Error(`${label} TURN sayacı okunamadı.`)
  }
  const sent = Number.parseInt(counters[1], 10)
  const received = Number.parseInt(counters[2], 10)
  const deliveryPercent = sent === 0 ? 0 : (received / sent) * 100
  if (deliveryPercent < 85) {
    throw new Error(
      `${label} TURN teslim oranı çok düşük: ${received}/${sent} ` +
        `(%${deliveryPercent.toFixed(1)}).`,
    )
  }
  return {
    label,
    sent,
    received,
    deliveryPercent,
    durationMilliseconds: Date.now() - startedAt,
  }
}

let failureCode

try {
  compose(['up', '-d', '--wait', 'coturn'])
  const containerId = compose(['ps', '-q', 'coturn']).trim()
  if (!containerId) throw new Error('Coturn container kimliği bulunamadı.')

  const qdisc = run(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      `container:${containerId}`,
      '--cap-add',
      'NET_ADMIN',
      '--entrypoint',
      '/bin/sh',
      networkToolsImage,
      '-c',
      [
        'apt-get update -qq',
        'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iproute2 >/dev/null',
        'tc qdisc replace dev eth0 root netem delay 80ms 20ms loss 2% rate 4mbit',
        'tc qdisc show dev eth0',
      ].join(' && '),
    ],
  )
  if (!qdisc.includes('netem') || !qdisc.includes('loss 2%')) {
    throw new Error('Ağ bozunumu uygulanamadı.')
  }

  const credential = createCredential()
  const udp = runRelayProbe('UDP', credential, [
    '-y',
    '-c',
    '-n',
    '100',
    '-l',
    '1000',
    '-z',
    '10',
  ])
  const tcp = runRelayProbe('TCP', credential, [
    '-t',
    '-y',
    '-c',
    '-n',
    '30',
    '-l',
    '1000',
    '-z',
    '10',
  ])

  process.stdout.write(`${redactSensitiveText(
    [
      'TURN ağ kalite probu başarılı.',
      'Koşul: 80±20 ms gecikme, %2 paket kaybı, 4 Mbit/s sınır.',
      `${udp.label}: ${udp.received}/${udp.sent} ` +
        `(%${udp.deliveryPercent.toFixed(1)}), ${udp.durationMilliseconds} ms.`,
      `${tcp.label}: ${tcp.received}/${tcp.sent} ` +
        `(%${tcp.deliveryPercent.toFixed(1)}), ${tcp.durationMilliseconds} ms.`,
    ].join('\n'),
    [sharedSecret, credential.username, credential.credential],
  )}\n`)
} catch {
  try {
    compose(['logs', '--no-color', '--tail', '100', 'coturn'])
  } catch {
    // Container kurulamamışsa ayrıca alınacak log olmayabilir.
  }
  failureCode = 'turn_network_quality_probe_failed'
} finally {
  try {
    compose(['down', '--volumes', '--remove-orphans'])
  } catch {
    failureCode ??= 'turn_network_quality_probe_cleanup_failed'
  }
}

if (failureCode) {
  process.stderr.write(`${redactSensitiveText(failureCode, [sharedSecret])}\n`)
  process.exitCode = 1
}
