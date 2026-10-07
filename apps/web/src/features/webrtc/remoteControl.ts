import type { ControlInputEvent } from '@ediz-remote/protocol'

export interface Rectangle {
  left: number
  top: number
  width: number
  height: number
}

export interface NormalizedPoint {
  x: number
  y: number
}

export interface CanvasPoint {
  left: number
  top: number
}

export function mapRemoteCursorToCanvas(
  cursor: NormalizedPoint,
  renderedVideo: Rectangle,
  canvas: Pick<Rectangle, 'left' | 'top'>,
  scrollLeft = 0,
  scrollTop = 0,
): CanvasPoint {
  return {
    left:
      renderedVideo.left - canvas.left + scrollLeft + cursor.x * renderedVideo.width,
    top:
      renderedVideo.top - canvas.top + scrollTop + cursor.y * renderedVideo.height,
  }
}

export function normalizeRemotePoint(
  clientX: number,
  clientY: number,
  container: Rectangle,
  videoWidth: number,
  videoHeight: number,
): NormalizedPoint | null {
  if (
    container.width <= 0 ||
    container.height <= 0 ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    return null
  }

  const scale = Math.min(
    container.width / videoWidth,
    container.height / videoHeight,
  )
  const renderedWidth = videoWidth * scale
  const renderedHeight = videoHeight * scale
  const renderedLeft = container.left + (container.width - renderedWidth) / 2
  const renderedTop = container.top + (container.height - renderedHeight) / 2
  return normalizeRemotePointInRectangle(clientX, clientY, {
    left: renderedLeft,
    top: renderedTop,
    width: renderedWidth,
    height: renderedHeight,
  })
}

export function normalizeRemotePointInRectangle(
  clientX: number,
  clientY: number,
  renderedVideo: Rectangle,
): NormalizedPoint | null {
  if (renderedVideo.width <= 0 || renderedVideo.height <= 0) return null
  const x = (clientX - renderedVideo.left) / renderedVideo.width
  const y = (clientY - renderedVideo.top) / renderedVideo.height

  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x: clampUnit(x), y: clampUnit(y) }
}

export function clampWheelDelta(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-10_000, Math.min(10_000, value))
}

export function pointerButtonName(
  button: number,
): Extract<ControlInputEvent, { kind: 'pointer.button' }>['button'] | null {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return null
}

export class ControlEventRateLimiter {
  private readonly timestamps: number[] = []
  private readonly maxEvents: number
  private readonly windowMs: number

  constructor(maxEvents: number, windowMs: number) {
    this.maxEvents = maxEvents
    this.windowMs = windowMs
  }

  tryConsume(now: number): boolean {
    const cutoff = now - this.windowMs
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift()
    }
    if (this.timestamps.length >= this.maxEvents) return false
    this.timestamps.push(now)
    return true
  }

  reset(): void {
    this.timestamps.length = 0
  }
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value))
}
