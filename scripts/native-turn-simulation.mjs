import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createIceConfiguration } from '../services/signaling/dist/ice.js'
import { redactSensitiveText } from './safe-output.mjs'

const composeFile = 'infra/coturn/compose.acceptance.yml'
const sharedSecret = randomBytes(32).toString('base64url')
let hostAddress = ''
let composeEnvironment

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeout ?? 120_000,
  })
  if (result.status !== 0) {
    throw new Error(redactSensitiveText('Native TURN yardımcı işlemi başarısız oldu.'))
  }
  return result
}

function compose(args) {
  return run('docker', ['compose', '-f', composeFile, ...args], {
    env: composeEnvironment,
  })
}

function createCredential(turnUrl) {
  const configuration = createIceConfiguration(
    `native-turn-simulation-${randomBytes(8).toString('hex')}`,
    Date.now(),
    {
      stunUrls: [],
      turnUrls: [turnUrl],
      turnSharedSecret: sharedSecret,
      turnCredentialTtlSeconds: 600,
    },
  )
  const server = configuration.iceServers.find((item) => item.username)
  if (!server?.username || !server.credential) {
    throw new Error('Native TURN simülasyonu için credential üretilemedi.')
  }
  return server
}

function runNativeSimulation(transport) {
  const turnUrl = `turn:${hostAddress}:3478?transport=${transport}`
  const server = createCredential(turnUrl)
  run(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/windows-host.ps1',
      'turn-simulation',
    ],
    {
      env: {
        ...process.env,
        EDIZ_TURN_SIMULATION: '1',
        EDIZ_TURN_URL: turnUrl,
        EDIZ_TURN_USERNAME: server.username,
        EDIZ_TURN_CREDENTIAL: server.credential,
      },
    },
  )
  process.stdout.write(`${redactSensitiveText(
    `${transport.toUpperCase()} relay-only native H.264 RTP simülasyonu başarılı.`,
    [sharedSecret, server.username, server.credential, hostAddress],
  )}\n`)
}

function selectHostIpv4Address() {
  const override = process.env.TURN_SIMULATION_HOST?.trim()
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

  if (candidates.length === 0) {
    throw new Error('Docker relay yayını için uygun host IPv4 adresi bulunamadı.')
  }
  return (
    candidates.find((address) => address.startsWith('192.168.')) ??
    candidates.find((address) => address.startsWith('10.')) ??
    candidates[0]
  )
}

let failureCode

try {
  hostAddress = selectHostIpv4Address()
  composeEnvironment = {
    ...process.env,
    TURN_SHARED_SECRET: sharedSecret,
    TURN_EXTERNAL_IP: hostAddress,
    TURN_MIN_PORT: process.env.TURN_SIMULATION_MIN_PORT?.trim() || '47000',
    TURN_MAX_PORT: process.env.TURN_SIMULATION_MAX_PORT?.trim() || '47020',
  }
  compose(['up', '-d', '--wait', 'coturn'])
  runNativeSimulation('udp')
  runNativeSimulation('tcp')
  process.stdout.write(`${redactSensitiveText(
    'Yerel zorlanmış TURN matrisi tamamlandı (UDP + TCP).',
    [sharedSecret, hostAddress],
  )}\n`)
} catch {
  try {
    compose(['logs', '--no-color', '--tail', '120', 'coturn'])
  } catch {
    // Container oluşmadıysa ayrıca gösterilecek log olmayabilir.
  }
  failureCode = 'native_turn_simulation_failed'
} finally {
  try {
    compose(['down', '--volumes', '--remove-orphans'])
  } catch {
    failureCode ??= 'native_turn_simulation_cleanup_failed'
  }
}

if (failureCode) {
  process.stderr.write(`${redactSensitiveText(
    failureCode,
    [sharedSecret, hostAddress],
  )}\n`)
  process.exitCode = 1
}
