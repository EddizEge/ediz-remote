import { redactSensitiveText } from './safe-output.mjs'

const TURN_URL_PATTERN =
  /^(turn|turns):(?:\/\/)?(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i

export function parseTurnEndpoint(value) {
  const match = TURN_URL_PATTERN.exec(value.trim())
  if (!match) {
    throw new Error(redactSensitiveText('Geçersiz TURN URL.'))
  }

  const secure = match[1].toLowerCase() === 'turns'
  const host = match[2].replace(/^\[|\]$/g, '')
  const port = match[3] ? Number.parseInt(match[3], 10) : secure ? 5349 : 3478
  const transport = (match[4] ?? (secure ? 'tcp' : 'udp')).toLowerCase()

  if (port < 1 || port > 65_535) {
    throw new Error(redactSensitiveText('TURN portu geçersiz.'))
  }

  return {
    originalUrl: value,
    secure,
    host,
    port,
    transport,
  }
}

export function parseRelayCounters(output) {
  const matches = [
    ...output.matchAll(/tot_send_msgs=(\d+),\s+tot_recv_msgs=(\d+)/g),
  ]
  const counters = matches.at(-1)
  if (!counters) {
    throw new Error('TURN gönderim/alım sayaçları okunamadı.')
  }

  const sent = Number.parseInt(counters[1], 10)
  const received = Number.parseInt(counters[2], 10)
  const deliveryPercent = sent === 0 ? 0 : (received / sent) * 100
  return { sent, received, deliveryPercent }
}

export function validateRelayCounters(
  counters,
  expectedSent,
  minimumDeliveryPercent,
) {
  if (counters.sent !== expectedSent) {
    throw new Error(
      `TURN relay mesaj sayısı beklenenden farklı: ${counters.sent}/${expectedSent}.`,
    )
  }
  if (counters.received > counters.sent) {
    throw new Error(
      `TURN alınan mesaj sayısı gönderilenden büyük: ${counters.received}/${counters.sent}.`,
    )
  }
  if (counters.deliveryPercent < minimumDeliveryPercent) {
    throw new Error(
      `TURN teslim oranı düşük: ${counters.received}/${counters.sent} ` +
        `(%${counters.deliveryPercent.toFixed(1)}).`,
    )
  }
  return counters
}

export function parseBoundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    const safeLabel = /^[A-Z][A-Z0-9_]{0,63}$/u.test(label)
      ? label
      : 'Yapılandırma değeri'
    throw new Error(
      redactSensitiveText(
        `${safeLabel} ${minimum}-${maximum} aralığında olmalıdır.`,
      ),
    )
  }
  return parsed
}
