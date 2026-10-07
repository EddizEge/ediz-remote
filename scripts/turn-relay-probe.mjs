import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createIceConfiguration } from '../services/signaling/dist/ice.js'
import { redactSensitiveText } from './safe-output.mjs'

const composeFile = 'infra/coturn/compose.test.yml'
const sharedSecret = randomBytes(32).toString('base64url')
const environment = { ...process.env, TURN_SHARED_SECRET: sharedSecret }

function dockerCompose(args, additionalEnvironment = {}) {
  const result = spawnSync(
    'docker',
    ['compose', '-f', composeFile, ...args],
    {
      cwd: process.cwd(),
      env: { ...environment, ...additionalEnvironment },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120_000,
      windowsHide: true,
    },
  )
  if (result.status !== 0) {
    throw new Error(redactSensitiveText('Docker Compose işlemi başarısız oldu.'))
  }
  return result.stdout ?? ''
}

let failureCode

try {
  dockerCompose(['up', '-d', '--wait', 'coturn'])

  const configuration = createIceConfiguration('relay-probe', Date.now(), {
    stunUrls: ['stun:coturn:3478'],
    turnUrls: ['turn:coturn:3478?transport=udp'],
    turnSharedSecret: sharedSecret,
    turnCredentialTtlSeconds: 600,
  })
  const turnServer = configuration.iceServers.find((server) => server.username)
  if (!turnServer?.username || !turnServer.credential) {
    throw new Error('Probe için TURN credential üretilemedi.')
  }

  const output = dockerCompose(
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
      'exec turnutils_uclient -y -c -n 3 -u "$TURN_PROBE_USERNAME" -w "$TURN_PROBE_CREDENTIAL" coturn',
    ],
    {
      TURN_PROBE_USERNAME: turnServer.username,
      TURN_PROBE_CREDENTIAL: turnServer.credential,
    },
  )
  if (!/tot_send_msgs=6,\s+tot_recv_msgs=6/.test(output)) {
    throw new Error('TURN relay probe beklenen gönderim/alım sayısına ulaşamadı.')
  }
  process.stdout.write(`${redactSensitiveText(
    'TURN relay probe başarılı: kısa ömürlü HMAC credential ile 6/6 mesaj relay üzerinden taşındı.',
    [sharedSecret, turnServer.username, turnServer.credential],
  )}\n`)
} catch {
  try {
    dockerCompose(['logs', '--no-color', '--tail', '100', 'coturn'])
  } catch {
    // İlk container oluşturulamadıysa ayrıca gösterilecek log olmayabilir.
  }
  failureCode = 'turn_relay_probe_failed'
} finally {
  try {
    dockerCompose(['down', '--volumes', '--remove-orphans'])
  } catch {
    failureCode ??= 'turn_relay_probe_cleanup_failed'
  }
}

if (failureCode) {
  process.stderr.write(`${redactSensitiveText(failureCode, [sharedSecret])}\n`)
  process.exitCode = 1
}
