import type { IceConfiguration } from '@ediz-remote/protocol'

const DEFAULT_STUN_URL =
  (import.meta.env.VITE_STUN_URL as string | undefined) ??
  'stun:stun.cloudflare.com:3478'

export function resolveIceServers(
  configuration: IceConfiguration | null,
): RTCIceServer[] {
  return configuration
    ? configuration.iceServers.map((server) => ({
        urls: [...server.urls],
        ...(server.username === undefined
          ? {}
          : {
              username: server.username,
              credential: server.credential,
            }),
      }))
    : [{ urls: [DEFAULT_STUN_URL] }]
}

export function hasTurnServer(configuration: IceConfiguration | null): boolean {
  return (
    configuration?.iceServers.some((server) =>
      server.urls.some((url) => /^turns?:/i.test(url)),
    ) ?? false
  )
}

export function resolveIceTransportPolicy(): RTCIceTransportPolicy {
  return import.meta.env.VITE_ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all'
}
