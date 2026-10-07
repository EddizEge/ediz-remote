import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react'
import type { ControlInputEvent } from '@ediz-remote/protocol'
import type { RemoteCursorState } from './peerProtocol'
import { MaximizeIcon, MonitorIcon } from '../../components/Icons'
import {
  clampWheelDelta,
  mapRemoteCursorToCanvas,
  normalizeRemotePointInRectangle,
  pointerButtonName,
  type NormalizedPoint,
} from './remoteControl'

interface RemoteViewerProps {
  stream: MediaStream | null
  sharing: boolean
  controlGranted: boolean
  sendControlEvent: (event: ControlInputEvent) => boolean
  subscribeToRemoteCursor: (
    listener: (state: RemoteCursorState) => void,
  ) => () => void
}

export function RemoteViewer({
  stream,
  sharing,
  controlGranted,
  sendControlEvent,
  subscribeToRemoteCursor,
}: RemoteViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLElement>(null)
  const remoteCursorRef = useRef<HTMLSpanElement>(null)
  const lastRemoteCursorRef = useRef<RemoteCursorState | null>(null)
  const [viewMode, setViewMode] = useState<'fit' | 'actual'>('fit')
  const [fullscreen, setFullscreen] = useState(false)
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 })
  const pendingPointerRef = useRef<NormalizedPoint | null>(null)
  const pointerFrameRef = useRef<number | null>(null)
  const heldButtonsRef = useRef(new Set<'left' | 'middle' | 'right'>())
  const heldKeysRef = useRef(
    new Map<string, { key: string; location: number }>(),
  )

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    return () => {
      if (video.srcObject === stream) video.srcObject = null
    }
  }, [stream])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === viewerRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const renderRemoteCursor = useCallback(
    (cursor: RemoteCursorState) => {
      lastRemoteCursorRef.current = cursor
      const element = remoteCursorRef.current
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!element || !cursor.visible || !stream || !canvas || !video) {
        if (element) element.hidden = true
        return
      }
      const position = mapRemoteCursorToCanvas(
        cursor,
        video.getBoundingClientRect(),
        canvas.getBoundingClientRect(),
        canvas.scrollLeft,
        canvas.scrollTop,
      )
      element.style.left = `${position.left}px`
      element.style.top = `${position.top}px`
      element.hidden = false
    },
    [stream],
  )

  useEffect(
    () => subscribeToRemoteCursor(renderRemoteCursor),
    [renderRemoteCursor, subscribeToRemoteCursor],
  )

  useEffect(() => {
    const cursor = lastRemoteCursorRef.current
    if (!cursor) return
    const frame = window.requestAnimationFrame(() => renderRemoteCursor(cursor))
    return () => window.cancelAnimationFrame(frame)
  }, [fullscreen, renderRemoteCursor, videoSize, viewMode])

  const releaseButtons = useCallback(() => {
    for (const button of heldButtonsRef.current) {
      sendControlEvent({ kind: 'pointer.button', button, down: false })
    }
    heldButtonsRef.current.clear()
  }, [sendControlEvent])

  const releaseAll = useCallback(() => {
    releaseButtons()
    for (const [code, key] of heldKeysRef.current) {
      sendControlEvent({
        kind: 'keyboard.key',
        code,
        key: key.key,
        location: key.location,
        down: false,
        repeat: false,
      })
    }
    heldKeysRef.current.clear()
  }, [releaseButtons, sendControlEvent])

  useEffect(() => {
    if (!controlGranted) {
      heldButtonsRef.current.clear()
      heldKeysRef.current.clear()
    }
  }, [controlGranted])

  useEffect(() => {
    const handleWindowBlur = () => releaseAll()
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') releaseAll()
    }
    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener('visibilitychange', handleVisibility)
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current)
      }
      releaseAll()
    }
  }, [releaseAll])

  const flushPointerMove = useCallback(() => {
    pointerFrameRef.current = null
    const point = pendingPointerRef.current
    pendingPointerRef.current = null
    if (point) {
      sendControlEvent({ kind: 'pointer.move', x: point.x, y: point.y })
    }
  }, [sendControlEvent])

  const queuePointerPosition = useCallback(
    (event: PointerEvent<HTMLDivElement>): boolean => {
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!controlGranted || !stream || !canvas || !video) return false
      const point = normalizeRemotePointInRectangle(
        event.clientX,
        event.clientY,
        video.getBoundingClientRect(),
      )
      if (!point) return false
      pendingPointerRef.current = point
      if (pointerFrameRef.current === null) {
        pointerFrameRef.current = window.requestAnimationFrame(flushPointerMove)
      }
      return true
    },
    [controlGranted, flushPointerMove, stream],
  )

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const button = pointerButtonName(event.button)
    if (!button || !queuePointerPosition(event)) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    heldButtonsRef.current.add(button)
    const point = pendingPointerRef.current
    sendControlEvent({
      kind: 'pointer.button',
      button,
      down: true,
      ...(point ? { x: point.x, y: point.y } : {}),
    })
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const button = pointerButtonName(event.button)
    if (!button || !controlGranted) return
    event.preventDefault()
    queuePointerPosition(event)
    heldButtonsRef.current.delete(button)
    const point = pendingPointerRef.current
    sendControlEvent({
      kind: 'pointer.button',
      button,
      down: false,
      ...(point ? { x: point.x, y: point.y } : {}),
    })
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handlePointerCancel = () => releaseButtons()

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!controlGranted || !stream) return
    event.preventDefault()
    sendControlEvent({
      kind: 'pointer.wheel',
      deltaX: clampWheelDelta(event.deltaX),
      deltaY: clampWheelDelta(event.deltaY),
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!controlGranted) return
    event.preventDefault()
    heldKeysRef.current.set(event.code, {
      key: event.key,
      location: event.location,
    })
    sendControlEvent({
      kind: 'keyboard.key',
      code: event.code,
      key: event.key,
      location: event.location,
      down: true,
      repeat: event.repeat,
    })
  }

  const handleKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!controlGranted) return
    event.preventDefault()
    heldKeysRef.current.delete(event.code)
    sendControlEvent({
      kind: 'keyboard.key',
      code: event.code,
      key: event.key,
      location: event.location,
      down: false,
      repeat: false,
    })
  }

  const toggleFullscreen = async () => {
    const viewer = viewerRef.current
    if (!viewer || !document.fullscreenEnabled) return
    if (document.fullscreenElement === viewer) await document.exitFullscreen()
    else await viewer.requestFullscreen()
  }

  return (
    <section ref={viewerRef} className="remote-viewer" data-testid="remote-viewer">
      <div className="remote-viewer__toolbar">
        <div>
          <span className="remote-viewer__live-dot" aria-hidden="true" />
          <strong>Uzak ekran</strong>
        </div>
        <div className="remote-viewer__toolbar-actions">
          <span data-testid="control-status">
            {controlGranted
              ? 'Kontrol izni açık'
              : 'Yalnızca görüntüleme'}
          </span>
          <div className="view-mode-group" aria-label="Görüntü ölçekleme">
            <button
              type="button"
              className={viewMode === 'fit' ? 'is-active' : ''}
              aria-pressed={viewMode === 'fit'}
              onClick={() => setViewMode('fit')}
            >
              Sığdır
            </button>
            <button
              type="button"
              className={viewMode === 'actual' ? 'is-active' : ''}
              aria-pressed={viewMode === 'actual'}
              onClick={() => setViewMode('actual')}
            >
              1:1 piksel
            </button>
          </div>
          <button
            type="button"
            className="fullscreen-button"
            onClick={() => void toggleFullscreen()}
            disabled={!document.fullscreenEnabled}
          >
            <MaximizeIcon />
            {fullscreen ? 'Tam ekrandan çık' : 'Tam ekran'}
          </button>
        </div>
      </div>
      <div
        ref={canvasRef}
        className={`remote-viewer__canvas remote-viewer__canvas--${viewMode}${controlGranted ? ' remote-viewer__canvas--control' : ''}`}
        data-testid="remote-control-surface"
        role="application"
        aria-label="Uzak masaüstü kontrol alanı"
        aria-disabled={!controlGranted}
        tabIndex={controlGranted ? 0 : -1}
        onPointerMove={queuePointerPosition}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={releaseButtons}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={releaseAll}
        onContextMenu={(event) => {
          if (controlGranted) event.preventDefault()
        }}
      >
        {stream ? (
          <video
            ref={videoRef}
            data-testid="remote-video"
            autoPlay
            playsInline
            muted
            onLoadedMetadata={(event) => {
              setVideoSize({
                width: event.currentTarget.videoWidth,
                height: event.currentTarget.videoHeight,
              })
            }}
            style={
              viewMode === 'actual' && videoSize.width > 0
                ? { width: videoSize.width, height: videoSize.height }
                : undefined
            }
          />
        ) : (
          <div className="remote-viewer__empty">
            <span><MonitorIcon /></span>
            <h1>{sharing ? 'Uzak görüntü hazırlanıyor' : 'Ekran paylaşımı bekleniyor'}</h1>
            <p>
              {sharing
                ? 'Görüntü akışı birkaç saniye içinde başlayacak.'
                : 'Karşı cihaz ekran paylaşımını başlattığında görüntü burada açılacak.'}
            </p>
          </div>
        )}
        {controlGranted && stream ? (
          <span className="remote-viewer__control-hint">
            Kontrol için görüntüye tıklayın
          </span>
        ) : null}
        <span
          ref={remoteCursorRef}
          className="remote-viewer__remote-cursor"
          data-testid="remote-cursor"
          aria-hidden="true"
          hidden
        >
          <svg viewBox="0 0 28 34">
            <path d="M3 2.5 23 20l-9.2 1.3 5.4 9.2-5.2 3-5.3-9.3L3 31Z" />
          </svg>
        </span>
      </div>
    </section>
  )
}
