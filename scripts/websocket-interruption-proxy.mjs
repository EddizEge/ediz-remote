import { WebSocket, WebSocketServer } from 'ws'
import { SIGNALING_SUBPROTOCOL } from '../packages/protocol/dist/index.js'
import { redactSensitiveText } from './safe-output.mjs'

try {
  startProxy()
} catch {
  process.stderr.write(
    `${redactSensitiveText('websocket_interruption_proxy_failed')}\n`,
  )
  process.exitCode = 1
}

function startProxy() {
  const portText = process.env.PROXY_PORT ?? '8790'
  if (!/^\d{1,5}$/u.test(portText)) {
    throw new Error('invalid_proxy_configuration')
  }
  const listenPort = Number(portText)
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error('invalid_proxy_configuration')
  }

  const upstreamUrl = validateUpstreamUrl(
    process.env.PROXY_UPSTREAM_URL ?? 'ws://127.0.0.1:8788/ws',
  )
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: listenPort,
    maxPayload: 64 * 1024,
  })

  server.on('connection', (client, request) => {
    let upstream
    try {
      upstream = new WebSocket(upstreamUrl, SIGNALING_SUBPROTOCOL, {
        maxPayload: 64 * 1024,
        origin:
          request.headers.origin ??
          process.env.PROXY_ORIGIN ??
          'http://localhost:8080',
      })
    } catch {
      client.close(1011, 'Upstream unavailable')
      return
    }
    const pendingMessages = []

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary })
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        if (pendingMessages.length >= 64) {
          client.close(1013, 'Proxy queue limit reached')
          return
        }
        pendingMessages.push({ data, isBinary })
      }
    })
    client.on('close', () => upstream.close())
    client.on('error', () => upstream.terminate())

    upstream.on('open', () => {
      for (const message of pendingMessages.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary })
      }
    })
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary })
      }
    })
    upstream.on('close', () => client.close())
    upstream.on('error', () => client.close(1011, 'Upstream unavailable'))
  })

  server.on('listening', () => {
    process.stdout.write(`${redactSensitiveText(
      `WebSocket interruption proxy listening on configured port ${listenPort}.`,
      [upstreamUrl],
    )}\n`)
  })

  server.on('error', () => {
    process.stderr.write(
      `${redactSensitiveText('WebSocket interruption proxy başlatılamadı.', [upstreamUrl])}\n`,
      () => process.exit(1),
    )
  })

  function shutdown() {
    for (const client of server.clients) client.terminate()
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function validateUpstreamUrl(value) {
  const url = new URL(value)
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    !isLoopbackHost(url.hostname) ||
    url.pathname !== '/ws' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('invalid_proxy_configuration')
  }
  return url.href
}

function isLoopbackHost(hostname) {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  )
}
