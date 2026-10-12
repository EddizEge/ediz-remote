import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  AuditDrillError,
  DRILL_RESOURCE_PREFIX,
  HEALTHCHECK_SCRIPT,
  HEALTHCHECK_SHELL_COMMAND,
  HELPER_CAPABILITIES,
  HELPER_IMAGE,
  HELPER_SCRIPTS,
  SIGNALING_SUBPROTOCOL,
  TMPFS_OPTIONS,
  assertDockerAvailable,
  buildHelperArguments,
  buildSignalingRunArguments,
  classifyHealthResponse,
  classifyNetworkError,
  classifyServiceLog,
  cleanupDrill,
  createDrillNames,
  evaluateContainerHardening,
  findStaleDrillResources,
  formatDrillLine,
  formatDuration,
  isBaselineLog,
  isDrillResourceName,
  isExpectedFailureLog,
  parseArguments,
  parsePublishedPort,
  resolveApplicationTarget,
  runAuditDrill,
  selectDrillResourceNames,
} from './audit-failure-drill.mjs'

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const NONCE = '0123456789ab'
const IMAGE_ID = `sha256:${'a1'.repeat(32)}`
const SENTINEL_SECRET = 'ER_SENTINEL_AUDIT_DRILL_SECRET_1234567890'

function readRepositoryFile(...segments) {
  return readFileSync(path.join(REPOSITORY_ROOT, ...segments), 'utf8')
}

function expectDrillError(callback, code) {
  assert.throws(callback, (error) => (
    error instanceof AuditDrillError && error.code === code
  ))
}

async function expectDrillRejection(promise, code) {
  await assert.rejects(promise, (error) => (
    error instanceof AuditDrillError && error.code === code
  ))
}

function fakeRunner(handler) {
  const calls = []
  const runner = (argumentsList, options) => {
    calls.push(argumentsList)
    return handler(argumentsList, options) ?? { status: 0, stdout: '', stderr: '' }
  }
  runner.calls = calls
  return runner
}

function hardenedInspect(names) {
  return {
    Image: IMAGE_ID,
    Config: {
      User: '1000:1000',
      Env: [
        'PATH=/usr/local/bin',
        'NODE_ENV=production',
        'SIGNALING_AUDIT_ENABLED=true',
        'SIGNALING_AUDIT_DIRECTORY=/var/lib/ediz-remote/security-audit',
        'SIGNALING_AUDIT_HMAC_KEY_FILE=/run/secrets/signaling_audit_hmac',
        'TURN_SHARED_SECRET_FILE=/run/secrets/turn_shared_secret',
      ],
      Healthcheck: {
        Test: ['CMD-SHELL', HEALTHCHECK_SHELL_COMMAND],
        Interval: 30e9,
        Timeout: 5e9,
        Retries: 3,
        StartPeriod: 10e9,
      },
    },
    HostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: null,
      Privileged: false,
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 256,
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      NetworkMode: names.network,
      Tmpfs: { '/tmp': TMPFS_OPTIONS },
      PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    },
    Mounts: [
      {
        Type: 'volume',
        Name: names.auditVolume,
        Destination: '/var/lib/ediz-remote/security-audit',
        RW: true,
      },
      {
        Type: 'volume',
        Name: names.secretVolume,
        Destination: '/run/secrets',
        RW: false,
      },
    ],
  }
}

test('argument parser accepts only the documented options', () => {
  assert.deepEqual(parseArguments([]), { image: null, attempts: 3, help: false })
  assert.equal(parseArguments(['--image', IMAGE_ID]).image, IMAGE_ID)
  assert.equal(
    parseArguments(['--image', 'ediz-remote/audit-drill:local']).image,
    'ediz-remote/audit-drill:local',
  )
  assert.equal(parseArguments(['--attempts', '5']).attempts, 5)
  assert.equal(parseArguments(['--help']).help, true)

  for (const argv of [
    ['--image'],
    ['--image', '--attempts'],
    ['--image', 'UPPER/case'],
    ['--image', 'ok;rm -rf /'],
    ['--image', IMAGE_ID, '--image', IMAGE_ID],
    ['--attempts', '0'],
    ['--attempts', '6'],
    ['--attempts', 'x'],
    ['--keep-going'],
    ['--bypass'],
    ['positional'],
  ]) {
    expectDrillError(() => parseArguments(argv), 'usage_invalid')
  }
})

test('resource names stay inside the unique drill prefix', () => {
  const names = createDrillNames(NONCE)
  const all = [
    names.container,
    names.network,
    names.auditVolume,
    names.secretVolume,
    ...Object.values(names.helper),
  ]
  assert.equal(new Set(all).size, all.length)
  for (const name of all) {
    assert.ok(name.startsWith(`${DRILL_RESOURCE_PREFIX}${NONCE}-`))
    assert.equal(isDrillResourceName(name, NONCE), true)
    assert.equal(isDrillResourceName(name, 'ffffffffffff'), false)
  }

  for (const foreign of [
    'ediz-remote',
    'ediz-remote-coturn',
    'ediz-remote_signaling-audit',
    `${DRILL_RESOURCE_PREFIX}${NONCE}`,
    `${DRILL_RESOURCE_PREFIX}${NONCE}-other`,
    `x${DRILL_RESOURCE_PREFIX}${NONCE}-signaling`,
    `${DRILL_RESOURCE_PREFIX}ZZZ-signaling`,
  ]) {
    assert.equal(isDrillResourceName(foreign), false, foreign)
  }
  expectDrillError(() => createDrillNames('not-a-nonce'), 'internal_error')
  expectDrillError(() => createDrillNames('0123456789AB'), 'internal_error')
})

test('docker substring filter results are narrowed to the prefix', () => {
  assert.deepEqual(
    selectDrillResourceNames([
      `/${DRILL_RESOURCE_PREFIX}${NONCE}-signaling`,
      `my-${DRILL_RESOURCE_PREFIX}${NONCE}-signaling`,
      'ediz-remote',
      '',
      `${DRILL_RESOURCE_PREFIX}${NONCE}-audit\r`,
    ].join('\n')),
    [
      `${DRILL_RESOURCE_PREFIX}${NONCE}-signaling`,
      `${DRILL_RESOURCE_PREFIX}${NONCE}-audit`,
    ],
  )
})

test('stale drill resources stop the drill without removing anything', async () => {
  const runner = fakeRunner((argumentsList) => {
    if (argumentsList[0] === 'version') return { status: 0, stdout: 'linux/amd64\n' }
    if (argumentsList[0] === 'context') {
      return { status: 0, stdout: '"npipe:////./pipe/dockerDesktopLinuxEngine"\n' }
    }
    if (argumentsList[0] === 'volume' && argumentsList[1] === 'ls') {
      return { status: 0, stdout: `${DRILL_RESOURCE_PREFIX}${NONCE}-audit\n` }
    }
    return { status: 0, stdout: '' }
  })
  assert.equal(findStaleDrillResources(runner), 1)
  await expectDrillRejection(
    runAuditDrill({ image: null, attempts: 1 }, { runner, emit: () => {} }),
    'stale_resources_present',
  )
  assert.ok(runner.calls.every((call) => !['rm', 'prune', 'stop', 'kill'].includes(call[1])))
  assert.ok(runner.calls.every((call) => !call.includes('prune')))
})

test('docker availability failures map to fixed codes', () => {
  expectDrillError(
    () => assertDockerAvailable(fakeRunner(() => ({ notFound: true, status: null }))),
    'docker_cli_unavailable',
  )
  expectDrillError(
    () => assertDockerAvailable(fakeRunner(() => ({ status: 1, stdout: '' }))),
    'docker_daemon_unavailable',
  )
  expectDrillError(
    () => assertDockerAvailable(fakeRunner(() => ({ status: 0, stdout: 'windows/amd64' }))),
    'linux_engine_required',
  )
  expectDrillError(
    () => assertDockerAvailable(fakeRunner((argumentsList) => (
      argumentsList[0] === 'version'
        ? { status: 0, stdout: 'linux/arm64' }
        : { status: 0, stdout: '"tcp://198.51.100.7:2376"' }
    ))),
    'docker_context_invalid',
  )
  assert.equal(
    assertDockerAvailable(fakeRunner((argumentsList) => (
      argumentsList[0] === 'version'
        ? { status: 0, stdout: 'linux/arm64\n' }
        : { status: 0, stdout: '"unix:///var/run/docker.sock"' }
    ))),
    'linux/arm64',
  )
})

test('application target is the final Dockerfile stage', () => {
  assert.equal(resolveApplicationTarget(readRepositoryFile('Dockerfile')), 'runtime')
  expectDrillError(() => resolveApplicationTarget('FROM node\n'), 'dockerfile_target_invalid')
})

test('run arguments mirror the production compose hardening', () => {
  const compose = readRepositoryFile('docker-compose.yml')
  assert.ok(compose.includes(`- /tmp:${TMPFS_OPTIONS}`))
  assert.ok(compose.includes(`"${HEALTHCHECK_SCRIPT}"`))
  for (const fragment of [
    'restart: unless-stopped',
    'read_only: true',
    'pids_limit: 256',
    '- ALL',
    '- no-new-privileges:true',
    'SIGNALING_AUDIT_DIRECTORY: /var/lib/ediz-remote/security-audit',
    'interval: 30s',
    'timeout: 5s',
    'retries: 3',
    'start_period: 10s',
  ]) {
    assert.ok(compose.includes(fragment), fragment)
  }

  const names = createDrillNames(NONCE)
  const run = buildSignalingRunArguments(names, IMAGE_ID)
  const pairs = new Map()
  for (let index = 0; index < run.length - 1; index += 1) {
    if (run[index].startsWith('--') && !pairs.has(run[index])) {
      pairs.set(run[index], run[index + 1])
    }
  }
  assert.equal(pairs.get('--name'), names.container)
  assert.equal(pairs.get('--network'), names.network)
  assert.equal(pairs.get('--restart'), 'unless-stopped')
  assert.equal(pairs.get('--pids-limit'), '256')
  assert.equal(pairs.get('--cap-drop'), 'ALL')
  assert.equal(pairs.get('--security-opt'), 'no-new-privileges:true')
  assert.equal(pairs.get('--tmpfs'), `/tmp:${TMPFS_OPTIONS}`)
  assert.equal(pairs.get('--publish'), '127.0.0.1::8080')
  assert.equal(pairs.get('--health-cmd'), HEALTHCHECK_SHELL_COMMAND)
  assert.ok(run.includes('--read-only'))
  assert.ok(!run.includes('--privileged'))
  assert.ok(!run.includes('--cap-add'))
  assert.ok(!run.some((argument) => argument.includes('0.0.0.0')))
  assert.ok(run.includes('NODE_ENV=production'))
  assert.ok(run.includes('SIGNALING_AUDIT_ENABLED=true'))
  assert.ok(!run.some((argument) => /^(?:TURN_SHARED_SECRET|SIGNALING_AUDIT_HMAC_KEY)=/u.test(argument)))
  assert.ok(run.includes(
    `type=volume,source=${names.secretVolume},target=/run/secrets,readonly`,
  ))
  assert.equal(run.at(-1), IMAGE_ID)
  expectDrillError(() => buildSignalingRunArguments(names, 'latest'), 'image_invalid')
})

test('drill constants match the protocol and pinned helper image', () => {
  assert.match(
    readRepositoryFile('packages', 'protocol', 'src', 'index.ts'),
    /SIGNALING_PROTOCOL_VERSION = 3 as const/u,
  )
  assert.equal(SIGNALING_SUBPROTOCOL, 'ediz-remote.v3')
  assert.ok(readRepositoryFile('scripts', 'browser-turn-simulation.mjs').includes(`'${HELPER_IMAGE}'`))
})

test('helper containers are isolated and never receive secrets in argv', () => {
  const names = createDrillNames(NONCE)
  for (const step of ['secrets', 'inspect', 'inject', 'restore']) {
    const volume = step === 'secrets' ? names.secretVolume : names.auditVolume
    const argumentsList = buildHelperArguments(
      names,
      step,
      volume,
      HELPER_SCRIPTS[step],
      { stdin: step === 'secrets' },
    )
    const joined = argumentsList.join(' ')
    assert.ok(joined.includes('--network none'))
    assert.ok(joined.includes('--cap-drop ALL'))
    assert.ok(joined.includes('--read-only'))
    assert.ok(joined.includes('--rm'))
    assert.ok(joined.includes(HELPER_IMAGE))
    assert.equal(argumentsList.includes('--interactive'), step === 'secrets')
    const added = argumentsList
      .map((argument, index) => (argument === '--cap-add' ? argumentsList[index + 1] : null))
      .filter(Boolean)
    assert.deepEqual(added, [...HELPER_CAPABILITIES[step]])
    assert.ok(!added.includes('DAC_OVERRIDE') && !added.includes('SYS_ADMIN'))
    assert.ok(!/(?:^|\s)-v\s|type=bind/u.test(joined))
  }
  assert.ok(!HELPER_SCRIPTS.secrets.includes('echo'))
  assert.match(HELPER_SCRIPTS.secrets, /chmod 0400/u)
  assert.match(HELPER_SCRIPTS.inspect, /set -o pipefail/u)
  assert.deepEqual([...HELPER_CAPABILITIES.inspect], ['DAC_READ_SEARCH'])
  assert.match(HELPER_SCRIPTS.inject, /chown 0:0 \/drill/u)
  assert.match(HELPER_SCRIPTS.restore, /chown 1000:1000 \/drill/u)
  assert.match(HELPER_SCRIPTS.restore, /chmod 0700 \/drill/u)
  expectDrillError(
    () => buildHelperArguments(names, 'other', names.auditVolume, 'true'),
    'internal_error',
  )
  expectDrillError(
    () => buildHelperArguments(names, 'inject', 'ediz-remote_signaling-audit', 'true'),
    'internal_error',
  )
})

test('container hardening evaluation flags every drift', () => {
  const names = createDrillNames(NONCE)
  assert.deepEqual(evaluateContainerHardening(hardenedInspect(names), names), [])

  const mutations = [
    ['read_only', (value) => { value.HostConfig.ReadonlyRootfs = false }],
    ['cap_drop', (value) => { value.HostConfig.CapDrop = [] }],
    ['cap_add', (value) => { value.HostConfig.CapAdd = ['NET_ADMIN'] }],
    ['privileged', (value) => { value.HostConfig.Privileged = true }],
    ['no_new_privileges', (value) => { value.HostConfig.SecurityOpt = [] }],
    ['pids_limit', (value) => { value.HostConfig.PidsLimit = 0 }],
    ['restart_policy', (value) => { value.HostConfig.RestartPolicy.Name = 'no' }],
    ['network', (value) => { value.HostConfig.NetworkMode = 'bridge' }],
    ['tmpfs', (value) => { value.HostConfig.Tmpfs['/tmp'] = 'size=64m' }],
    ['port_binding', (value) => {
      value.HostConfig.PortBindings['8080/tcp'][0].HostIp = '0.0.0.0'
    }],
    ['user', (value) => { value.Config.User = '' }],
    ['environment', (value) => { value.Config.Env = [] }],
    ['inline_secret', (value) => {
      value.Config.Env.push(`TURN_SHARED_SECRET=${SENTINEL_SECRET}`)
    }],
    ['healthcheck', (value) => { value.Config.Healthcheck.Interval = 1e9 }],
    ['mounts', (value) => { value.Mounts[1].RW = true }],
  ]
  for (const [issue, mutate] of mutations) {
    const inspect = hardenedInspect(names)
    mutate(inspect)
    assert.ok(evaluateContainerHardening(inspect, names).includes(issue), issue)
  }
})

test('published port must be a single loopback binding', () => {
  assert.equal(parsePublishedPort('127.0.0.1:49153\n'), 49153)
  for (const text of [
    '',
    '0.0.0.0:49153',
    '[::]:49153',
    '127.0.0.1:49153\n[::1]:49153',
    '127.0.0.1:0',
    '127.0.0.1:70000',
  ]) {
    expectDrillError(() => parsePublishedPort(text), 'port_mapping_invalid')
  }
})

test('service log classification counts only fixed codes', () => {
  const baseline = classifyServiceLog('{"type":"service.ready","port":8080}\n')
  assert.equal(isBaselineLog(baseline), true)

  const failure = classifyServiceLog([
    '{"type":"service.ready","port":8080}',
    '{"type":"service.error","code":"audit_unavailable"}',
    '{"type":"service.error","code":"startup_failed"}',
    '{"type":"service.error","code":"startup_failed"}',
    '',
  ].join('\r\n'))
  assert.equal(failure.ready, 1)
  assert.equal(failure.codes.audit_unavailable, 1)
  assert.equal(failure.codes.startup_failed, 2)
  assert.equal(failure.unexpected, 0)
  assert.deepEqual(failure.sequence, [
    'ready',
    'audit_unavailable',
    'startup_failed',
    'startup_failed',
  ])
  assert.equal(isExpectedFailureLog(failure), true)
  assert.equal(isBaselineLog(failure), false)

  const leaked = classifyServiceLog([
    '{"type":"service.ready","port":8080}',
    '{"type":"service.error","code":"audit_unavailable"}',
    `Error: EACCES ${SENTINEL_SECRET} /var/lib/ediz-remote/security-audit`,
    '{"type":"service.error","code":"audit_unavailable","path":"/x"}',
    '{"type":"service.error","code":"unknown_code"}',
    '{"type":"service.ready","port":8080,"ip":"198.51.100.7"}',
  ].join('\n'))
  assert.equal(leaked.unexpected, 4)
  assert.deepEqual(leaked.sequence, [
    'ready',
    'audit_unavailable',
    'unexpected',
    'unexpected',
    'unexpected',
    'unexpected',
  ])
  assert.equal(
    classifyServiceLog('{"type":"service.ready","port":8080}\n'.repeat(40)).sequence.length,
    12,
  )
  assert.equal(isExpectedFailureLog(leaked), false)
  assert.ok(!JSON.stringify(leaked).includes(SENTINEL_SECRET))

  assert.equal(isExpectedFailureLog(classifyServiceLog([
    '{"type":"service.ready","port":8080}',
    '{"type":"service.error","code":"unhandled_rejection"}',
    '{"type":"service.error","code":"audit_unavailable"}',
  ].join('\n'))), false)
  assert.equal(isExpectedFailureLog(classifyServiceLog(
    '{"type":"service.ready","port":8080}\n',
  )), false)
})

test('health and network results are reduced to fixed outcomes', () => {
  assert.equal(classifyHealthResponse(200, '{"status":"ok","sessions":0}'), 'ok')
  assert.equal(classifyHealthResponse(503, '{"status":"unavailable"}'), 'unavailable')
  assert.equal(classifyHealthResponse(503, '{"status":"unavailable","detail":"x"}'), 'invalid')
  assert.equal(classifyHealthResponse(200, '{"status":"unavailable"}'), 'invalid')
  assert.equal(classifyHealthResponse(500, 'stack trace'), 'invalid')
  assert.equal(classifyNetworkError({ code: 'ECONNREFUSED' }), 'refused')
  assert.equal(classifyNetworkError({ code: 'ECONNRESET' }), 'reset')
  assert.equal(classifyNetworkError({ code: 'drill_timeout' }), 'timeout')
  assert.equal(classifyNetworkError(new Error('198.51.100.7')), 'other')
})

test('output lines are fixed-format and refuse sensitive values', () => {
  const imageId = `sha256:${'1234567a'.repeat(8)}`
  assert.equal(
    formatDrillLine('failure', 'observed', {
      attempt: 1,
      healthStatuses: ['200', '503', 'refused'],
      exitCode: 1,
      exitAfter: formatDuration(812.4),
      imageId,
      loopbackOnly: true,
    }, [SENTINEL_SECRET]),
    `audit_drill:failure:observed attempt=1 healthStatuses=200,503,refused exitCode=1 exitAfter=812ms imageId=${imageId} loopbackOnly=true`,
  )
  assert.equal(formatDuration(123_456), '123.5s')
  assert.equal(formatDrillLine('x', 'y', { list: [] }), 'audit_drill:x:y list=none')

  for (const fields of [
    { value: SENTINEL_SECRET },
    { value: '198.51.100.7' },
    { value: 'Error: EACCES' },
    { value: '/var/lib/ediz-remote' },
    { value: 123_456 },
    { value: 1.5 },
    { value: { nested: true } },
    { 'bad-key': 1 },
    { value: 'sha256:short' },
  ]) {
    expectDrillError(() => formatDrillLine('phase', 'result', fields, [SENTINEL_SECRET]), 'output_unsafe')
  }
  expectDrillError(() => formatDrillLine('Phase', 'result'), 'output_unsafe')
  expectDrillError(
    () => formatDrillLine('phase', 'result', { imageId: `sha256:${'ab'.repeat(32)}` }, ['abababab']),
    'output_unsafe',
  )
})

test('cleanup removes only exact drill names and verifies by listing', () => {
  const names = createDrillNames(NONCE)
  let listed = `${names.container}\n`
  const runner = fakeRunner((argumentsList) => {
    if (argumentsList[1] === 'rm') {
      if (argumentsList.at(-1) === names.container) listed = ''
      return { status: 0, stdout: '' }
    }
    if (argumentsList[1] === 'ls') {
      return { status: 0, stdout: argumentsList[0] === 'container' ? listed : '' }
    }
    return { status: 1, stdout: '' }
  })
  const state = { names, events: { stop() {} }, cleaned: false }
  assert.equal(cleanupDrill(runner, state), true)
  assert.equal(cleanupDrill(runner, state), true)
  const removals = runner.calls.filter((call) => call[1] === 'rm')
  assert.ok(removals.length > 0)
  for (const call of removals) {
    assert.equal(isDrillResourceName(call.at(-1), NONCE), true)
    assert.ok(!call.includes('--filter'))
    assert.ok(!call.includes('--volumes'))
  }
  assert.ok(runner.calls.every((call) => !call.includes('prune')))

  const stuck = fakeRunner((argumentsList) => (
    argumentsList[1] === 'ls' && argumentsList[0] === 'volume'
      ? { status: 0, stdout: `${names.auditVolume}\n` }
      : { status: 0, stdout: '' }
  ))
  assert.equal(cleanupDrill(stuck, { names, cleaned: false }), false)
})
