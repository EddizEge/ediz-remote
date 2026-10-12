import { useCallback, useEffect, useRef, useState } from 'react'
import type { IceConfiguration } from '@ediz-remote/protocol'

export interface LaneRetryOptions {
  // The caller already sent `refresh_ice`; rebuild again when it is answered.
  awaitIceRefresh?: boolean
}

export interface LaneIceConfiguration {
  // Latest configuration; read only when the lane builds its peer.
  iceConfigurationRef: { readonly current: IceConfiguration | null }
  // Changes only when this lane's own `refresh_ice` is answered.
  ownIceRefreshVersion: number
  requestOwnIceRefresh: () => boolean
  awaitOwnIceRefresh: () => void
}

/**
 * The general peer and native-video lanes share one signaling connection and
 * one ICE configuration, but `refresh_ice` answers carry no lane identity.
 * Each lane therefore remembers whether it is waiting for its own refresh and
 * rebuilds only for that answer. Another lane's refresh just updates the
 * stored credential for this lane's next rebuild, so a healthy peer is never
 * torn down and the remote side never sees an unexpected abort. Approval and
 * resume (`iceResetVersion`) still rebuild every lane.
 */
export function useLaneIceConfiguration(
  iceConfiguration: IceConfiguration | null,
  iceResetVersion: number,
  requestIceRefresh: () => boolean,
): LaneIceConfiguration {
  const iceConfigurationRef = useRef(iceConfiguration)
  const seenIceResetVersionRef = useRef(iceResetVersion)
  const ownIceRefreshPendingRef = useRef(false)
  const [ownIceRefreshVersion, setOwnIceRefreshVersion] = useState(0)

  useEffect(() => {
    iceConfigurationRef.current = iceConfiguration
    if (seenIceResetVersionRef.current !== iceResetVersion) {
      // The reset already rebuilds the lane with this configuration.
      seenIceResetVersionRef.current = iceResetVersion
      ownIceRefreshPendingRef.current = false
      return
    }
    if (iceConfiguration === null || !ownIceRefreshPendingRef.current) return
    ownIceRefreshPendingRef.current = false
    setOwnIceRefreshVersion((current) => current + 1)
  }, [iceConfiguration, iceResetVersion])

  const requestOwnIceRefresh = useCallback(() => {
    if (!requestIceRefresh()) return false
    ownIceRefreshPendingRef.current = true
    return true
  }, [requestIceRefresh])

  const awaitOwnIceRefresh = useCallback(() => {
    ownIceRefreshPendingRef.current = true
  }, [])

  return {
    iceConfigurationRef,
    ownIceRefreshVersion,
    requestOwnIceRefresh,
    awaitOwnIceRefresh,
  }
}
