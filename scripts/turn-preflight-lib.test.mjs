import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  parseBoundedInteger,
  parseRelayCounters,
  parseTurnEndpoint,
  validateRelayCounters,
} from './turn-preflight-lib.mjs'

test('parses UDP and TCP TURN endpoints', () => {
  assert.deepEqual(parseTurnEndpoint('turn:turn.example.com:3478?transport=udp'), {
    originalUrl: 'turn:turn.example.com:3478?transport=udp',
    secure: false,
    host: 'turn.example.com',
    port: 3478,
    transport: 'udp',
  })
  assert.equal(
    parseTurnEndpoint('turn:turn.example.com:443?transport=tcp').transport,
    'tcp',
  )
})

test('uses protocol defaults and supports bracketed IPv6', () => {
  assert.equal(parseTurnEndpoint('turn:turn.example.com').port, 3478)
  assert.deepEqual(parseTurnEndpoint('turns:[2001:db8::1]'), {
    originalUrl: 'turns:[2001:db8::1]',
    secure: true,
    host: '2001:db8::1',
    port: 5349,
    transport: 'tcp',
  })
})

test('rejects malformed TURN endpoints', () => {
  assert.throws(() => parseTurnEndpoint('https://turn.example.com'))
  assert.throws(() => parseTurnEndpoint('turn:user:pass@turn.example.com'))
  assert.throws(() => parseTurnEndpoint('turn:turn.example.com:70000'))
})

test('does not echo a rejected TURN_URLS value', () => {
  const sentinelUrl =
    'turn:ER_SENTINEL_USERNAME:ER_SENTINEL_CREDENTIAL@203.0.113.77:3478?transport=udp'

  assert.throws(
    () => parseTurnEndpoint(sentinelUrl),
    (error) => {
      assert.equal(error.message, 'Geçersiz TURN URL.')
      assert.equal(error.message.includes(sentinelUrl), false)
      assert.equal(error.message.includes('ER_SENTINEL_USERNAME'), false)
      assert.equal(error.message.includes('ER_SENTINEL_CREDENTIAL'), false)
      assert.equal(error.message.includes('203.0.113.77'), false)
      return true
    },
  )
})

test('reads the final turnutils relay counters', () => {
  assert.deepEqual(
    parseRelayCounters(
      'tot_send_msgs=2, tot_recv_msgs=1\ntot_send_msgs=6, tot_recv_msgs=6',
    ),
    { sent: 6, received: 6, deliveryPercent: 100 },
  )
})

test('requires the expected relay payload count', () => {
  assert.deepEqual(validateRelayCounters({ sent: 6, received: 6, deliveryPercent: 100 }, 6, 95), {
    sent: 6,
    received: 6,
    deliveryPercent: 100,
  })
  assert.throws(
    () => validateRelayCounters({ sent: 2, received: 2, deliveryPercent: 100 }, 6, 95),
    /beklenenden farklı/,
  )
  assert.throws(
    () => validateRelayCounters({ sent: 6, received: 5, deliveryPercent: 83.3 }, 6, 95),
    /teslim oranı düşük/,
  )
})

test('validates bounded numeric options', () => {
  assert.equal(parseBoundedInteger(undefined, 3, 1, 50, 'Mesaj'), 3)
  assert.equal(parseBoundedInteger('10', 3, 1, 50, 'Mesaj'), 10)
  assert.throws(() => parseBoundedInteger('0', 3, 1, 50, 'Mesaj'))
  assert.throws(() => parseBoundedInteger('1.5', 3, 1, 50, 'Mesaj'))
})

test('production coturn loads the generated authenticated configuration', () => {
  const entrypoint = readFileSync('infra/coturn/entrypoint.sh', 'utf8')
  assert.match(entrypoint, /echo "lt-cred-mech"/)
  assert.match(entrypoint, /echo "use-auth-secret"/)
  assert.match(entrypoint, /-c "\$config_file"/)
  assert.doesNotMatch(entrypoint, /exec turnserver \\\r?\n\s+-n \\/)
})

test('production coturn suppresses raw connection logs by default', () => {
  const entrypoint = readFileSync('infra/coturn/entrypoint.sh', 'utf8')
  const productionCompose = readFileSync('infra/coturn/compose.yml', 'utf8')
  const acceptanceCompose = readFileSync(
    'infra/coturn/compose.acceptance.yml',
    'utf8',
  )
  const localTestCompose = readFileSync('infra/coturn/compose.test.yml', 'utf8')
  const browserSimulation = readFileSync(
    'scripts/browser-turn-simulation.mjs',
    'utf8',
  )

  assert.match(entrypoint, /log_output="discard"/)
  assert.match(entrypoint, /echo "no-stdout-log"/)
  assert.match(entrypoint, /echo "log-file=\/dev\/null"/)
  assert.match(productionCompose, /TURN_LOG_OUTPUT: discard/)
  assert.match(productionCompose, /driver:\s*"none"/u)
  assert.match(acceptanceCompose, /TURN_LOG_OUTPUT: discard/)
  assert.match(acceptanceCompose, /driver:\s*"none"/u)
  assert.match(localTestCompose, /TURN_LOG_OUTPUT: discard/)
  assert.match(localTestCompose, /driver:\s*"none"/u)
  assert.match(browserSimulation, /TURN_LOG_OUTPUT=discard/u)
  assert.match(browserSimulation, /--log-driver=none/u)
  assert.match(browserSimulation, /--no-stdout-log/u)
  assert.doesNotMatch(browserSimulation, /--log-file=stdout/u)
})

test('production services load the TURN secret from a bounded file', () => {
  const entrypoint = readFileSync('infra/coturn/entrypoint.sh', 'utf8')
  const coturnCompose = readFileSync('infra/coturn/compose.yml', 'utf8')
  const applicationCompose = readFileSync('docker-compose.yml', 'utf8')

  for (const compose of [coturnCompose, applicationCompose]) {
    assert.match(
      compose,
      /TURN_SHARED_SECRET_FILE:\s*\/run\/secrets\/turn_shared_secret/u,
    )
    assert.doesNotMatch(compose, /^\s*TURN_SHARED_SECRET:/mu)
    assert.match(compose, /source:\s*turn_shared_secret/u)
    assert.match(compose, /mode:\s*0400/u)
  }

  assert.match(entrypoint, /\[ ! -L "\$secret_file" \]/u)
  assert.match(entrypoint, /stat -c '%u:%g'/u)
  assert.match(entrypoint, /400\|600/u)
  assert.match(entrypoint, /\[ "\$secret_size" -le 4096 \]/u)
  assert.match(
    entrypoint,
    /unset TURN_SHARED_SECRET TURN_SHARED_SECRET_FILE/u,
  )
  assert.match(entrypoint, /unset secret/u)
  assert.match(coturnCompose, /^\s*user:\s*"1000:1000"\s*$/mu)
  assert.match(coturnCompose, /^\s*read_only:\s*true\s*$/mu)
  assert.match(coturnCompose, /^\s*pids_limit:\s*256\s*$/mu)
  assert.match(coturnCompose, /uid=1000,gid=1000/u)
  assert.doesNotMatch(coturnCompose, /^\s*cap_add:/mu)
  assert.match(coturnCompose, /no-new-privileges:true/u)
})

test('TURN probes and interruption proxy keep process output behind safe-output', () => {
  const scriptNames = [
    'turn-relay-probe.mjs',
    'turn-network-quality-probe.mjs',
    'native-turn-simulation.mjs',
    'turn-public-preflight.mjs',
    'turn-preflight-lib.mjs',
    'websocket-interruption-proxy.mjs',
  ]

  for (const scriptName of scriptNames) {
    const source = readFileSync(new URL(scriptName, import.meta.url), 'utf8')
    assert.match(source, /from '\.\/safe-output\.mjs'/u, scriptName)
    assert.doesNotMatch(source, /stdio:\s*[^\r\n]*['"]inherit['"]/u, scriptName)
    assert.doesNotMatch(
      source,
      /process\.stderr\.write\(\s*(?:result\.(?:stdout|stderr)|output|qdisc)/u,
      scriptName,
    )
    assert.doesNotMatch(source, /(?:args|argumentsList)\.join\(/u, scriptName)

    const stdoutWrites = source.match(/process\.stdout\.write\(/gu)?.length ?? 0
    const safeStdoutWrites =
      source.match(/process\.stdout\.write\(`\$\{redactSensitiveText\(/gu)
        ?.length ?? 0
    assert.equal(stdoutWrites, safeStdoutWrites, scriptName)

    const stderrWrites = source.match(/process\.stderr\.write\(/gu)?.length ?? 0
    const safeStderrWrites =
      source.match(
        /process\.stderr\.write\(\s*`\$\{redactSensitiveText\(/gu,
      )?.length ?? 0
    assert.equal(stderrWrites, safeStderrWrites, scriptName)
  }

  const publicPreflight = readFileSync(
    new URL('turn-public-preflight.mjs', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(publicPreflight, /result\.host/u)
  assert.doesNotMatch(publicPreflight, /redactCredential/u)
  assert.doesNotMatch(
    publicPreflight,
    /'-u',\s*username|'-w',\s*credential|String\(port\),\s*host/u,
  )
  assert.match(publicPreflight, /--log-driver=none/u)

  const nativeSimulation = readFileSync(
    new URL('native-turn-simulation.mjs', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(
    nativeSimulation,
    /matrisi tamamlandı \(\$\{hostAddress\}/u,
  )

  const relayProbe = readFileSync(
    new URL('turn-relay-probe.mjs', import.meta.url),
    'utf8',
  )
  const networkProbe = readFileSync(
    new URL('turn-network-quality-probe.mjs', import.meta.url),
    'utf8',
  )
  for (const source of [relayProbe, networkProbe]) {
    assert.doesNotMatch(
      source,
      /'-u',\s*(?:turnServer\.username|credential\.username)|'-w',\s*(?:turnServer\.credential|credential\.credential)/u,
    )
    assert.match(source, /TURN_PROBE_USERNAME/u)
    assert.match(source, /timeout:\s*120_000/u)
  }
  assert.doesNotMatch(networkProbe, /['"]debian:13-slim['"]/u)
  assert.match(networkProbe, /debian:13-slim@sha256:[a-f0-9]{64}/u)

  const interruptionProxy = readFileSync(
    new URL('websocket-interruption-proxy.mjs', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(interruptionProxy, /-> \$\{upstreamUrl\}/u)
})

test('top-level probe failures emit one fixed code without a Node stack', () => {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  )
  const missingCommandPath = fileURLToPath(
    new URL('__missing_commands__/', import.meta.url),
  )
  const turnUrl = 'turn:203.0.113.77:3478?transport=udp'
  const turnSecret = 'ER_SENTINEL_TURN_SHARED_SECRET_0123456789'
  const cases = [
    ['turn-relay-probe.mjs', 'turn_relay_probe_failed', {}],
    [
      'turn-network-quality-probe.mjs',
      'turn_network_quality_probe_failed',
      {},
    ],
    [
      'native-turn-simulation.mjs',
      'native_turn_simulation_failed',
      { TURN_SIMULATION_HOST: '203.0.113.77' },
    ],
    [
      'turn-public-preflight.mjs',
      'turn_public_preflight_failed',
      {
        TURN_URLS: turnUrl,
        TURN_SHARED_SECRET: turnSecret,
        TURN_CREDENTIAL_TTL_SECONDS: '600',
        TURN_PREFLIGHT_SKIP_HOST_CHECKS: 'true',
      },
    ],
    [
      'websocket-interruption-proxy.mjs',
      'websocket_interruption_proxy_failed',
      { PROXY_PORT: 'ER_SENTINEL_INVALID_PORT' },
    ],
  ]

  for (const [scriptName, failureCode, extraEnvironment] of cases) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(scriptName, import.meta.url))],
      {
        cwd: process.cwd(),
        env: {
          ...inheritedEnvironment,
          PATH: missingCommandPath,
          ...extraEnvironment,
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    )

    assert.equal(result.error, undefined, scriptName)
    assert.equal(result.status, 1, scriptName)
    assert.equal(result.stdout, '', scriptName)
    assert.equal(result.stderr.trim(), failureCode, scriptName)
    assert.equal(
      result.stderr.split(/\r?\n/u).filter(Boolean).length,
      1,
      scriptName,
    )
    assert.doesNotMatch(result.stderr, /(?:Error:|\s+at\s+|file:\/\/)/u, scriptName)
    for (const forbidden of [turnUrl, turnSecret, '203.0.113.77']) {
      assert.equal(result.stderr.includes(forbidden), false, scriptName)
    }
  }
})

test('probe cleanup failures cannot replace the primary fixed failure code', () => {
  const sources = new Map(
    [
      ['turn-relay-probe.mjs', 'turn_relay_probe_cleanup_failed'],
      [
        'turn-network-quality-probe.mjs',
        'turn_network_quality_probe_cleanup_failed',
      ],
      ['native-turn-simulation.mjs', 'native_turn_simulation_cleanup_failed'],
    ].map(([scriptName, cleanupCode]) => [
      cleanupCode,
      readFileSync(new URL(scriptName, import.meta.url), 'utf8'),
    ]),
  )

  for (const [cleanupCode, source] of sources) {
    assert.match(source, new RegExp(`failureCode \\?\\?= '${cleanupCode}'`, 'u'))
    assert.match(source, /finally \{\s*try \{/u)
    assert.doesNotMatch(source, /^\s*throw error\s*$/gmu)
    assert.match(source, /process\.exitCode = 1/u)
  }
})
