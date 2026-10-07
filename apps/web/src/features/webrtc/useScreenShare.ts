import { useCallback, useEffect, useRef, useState } from 'react'
import {
  screenShareIssueMessage,
  type ScreenShareIssueCode,
} from '../session/userFacingIssue'
import type { QualityProfile } from './peerProtocol'

export type ScreenShareStatus = 'idle' | 'requesting' | 'sharing'

export function useScreenShare(qualityProfile: QualityProfile = 'auto') {
  const streamRef = useRef<MediaStream | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [status, setStatus] = useState<ScreenShareStatus>('idle')
  const [errorCode, setErrorCode] = useState<ScreenShareIssueCode | null>(null)
  const error = screenShareIssueMessage(errorCode)

  const stop = useCallback(() => {
    const activeStream = streamRef.current
    streamRef.current = null
    for (const track of activeStream?.getTracks() ?? []) track.stop()
    setStream(null)
    setStatus('idle')
    setErrorCode(null)
  }, [])

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setErrorCode('unsupported')
      return false
    }

    setStatus('requesting')
    setErrorCode(null)
    try {
      const nextStream = await navigator.mediaDevices.getDisplayMedia({
        video: screenShareVideoConstraints(qualityProfile),
        audio: false,
      })
      stop()
      streamRef.current = nextStream
      setStream(nextStream)
      setStatus('sharing')

      const videoTrack = nextStream.getVideoTracks()[0]
      videoTrack?.addEventListener('ended', () => {
        if (streamRef.current === nextStream) {
          streamRef.current = null
          setStream(null)
          setStatus('idle')
          setErrorCode(null)
        }
      }, { once: true })
      return true
    } catch (caughtError) {
      setStatus(hasLiveVideoTrack(streamRef.current) ? 'sharing' : 'idle')
      if (caughtError instanceof DOMException && caughtError.name === 'NotAllowedError') {
        setErrorCode('selection_cancelled')
      } else {
        setErrorCode('start_failed')
      }
      return false
    }
  }, [qualityProfile, stop])

  useEffect(() => {
    const track = stream?.getVideoTracks()[0]
    if (!track) return
    let disposed = false
    void track.applyConstraints(screenShareVideoConstraints(qualityProfile)).then(() => {
      if (!disposed) setErrorCode(null)
    }).catch(() => {
      if (!disposed) setErrorCode('quality_failed')
    })
    return () => {
      disposed = true
    }
  }, [qualityProfile, stream])

  useEffect(() => stop, [stop])

  return { stream, status, error, errorCode, start, stop }
}

function hasLiveVideoTrack(stream: MediaStream | null): boolean {
  return stream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false
}

export function screenShareVideoConstraints(
  profile: QualityProfile,
): MediaTrackConstraints {
  if (profile === 'speed') {
    return {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 20, max: 24 },
    }
  }
  if (profile === 'quality') {
    return {
      width: { ideal: 2560, max: 3840 },
      height: { ideal: 1440, max: 2160 },
      frameRate: { ideal: 30, max: 30 },
    }
  }
  return {
    width: { ideal: 1920, max: 2560 },
    height: { ideal: 1080, max: 1440 },
    frameRate: { ideal: 30, max: 30 },
  }
}
