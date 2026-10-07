import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hookRuntime = vi.hoisted(() => {
  let slots: unknown[] = []
  let cursor = 0

  function nextSlot() {
    const slot = cursor
    cursor += 1
    return slot
  }

  return {
    beginRender() {
      cursor = 0
    },
    reset() {
      slots = []
      cursor = 0
    },
    useCallback<T>(callback: T) {
      nextSlot()
      return callback
    },
    useEffect() {
      nextSlot()
    },
    useRef<T>(initialValue: T) {
      const slot = nextSlot()
      if (!(slot in slots)) slots[slot] = { current: initialValue }
      return slots[slot] as { current: T }
    },
    useState<T>(initialValue: T | (() => T)) {
      const slot = nextSlot()
      if (!(slot in slots)) {
        slots[slot] =
          typeof initialValue === 'function'
            ? (initialValue as () => T)()
            : initialValue
      }
      const setValue = (nextValue: T | ((current: T) => T)) => {
        slots[slot] =
          typeof nextValue === 'function'
            ? (nextValue as (current: T) => T)(slots[slot] as T)
            : nextValue
      }
      return [slots[slot] as T, setValue] as const
    },
  }
})

vi.mock('react', () => ({
  useCallback: hookRuntime.useCallback,
  useEffect: hookRuntime.useEffect,
  useRef: hookRuntime.useRef,
  useState: hookRuntime.useState,
}))

import { screenShareVideoConstraints, useScreenShare } from './useScreenShare'

beforeEach(() => {
  hookRuntime.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function useRenderScreenShare() {
  hookRuntime.beginRender()
  return useScreenShare()
}

function createDisplayStream() {
  const stop = vi.fn()
  const track = {
    readyState: 'live',
    stop,
    addEventListener: vi.fn(),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  } as unknown as MediaStreamTrack
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream
  return { stream, stop }
}

describe('screen share quality profiles', () => {
  it('uses bounded resolution and frame-rate targets', () => {
    expect(screenShareVideoConstraints('speed')).toMatchObject({
      width: { max: 1280 },
      height: { max: 720 },
      frameRate: { max: 24 },
    })
    expect(screenShareVideoConstraints('auto')).toMatchObject({
      width: { max: 2560 },
      height: { max: 1440 },
      frameRate: { max: 30 },
    })
    expect(screenShareVideoConstraints('quality')).toMatchObject({
      width: { max: 3840 },
      height: { max: 2160 },
      frameRate: { max: 30 },
    })
  })
})

describe('screen share replacement recovery', () => {
  it.each([
    {
      label: 'picker iptal edildiğinde',
      failure: new DOMException('cancelled', 'NotAllowedError'),
      errorCode: 'selection_cancelled',
      message: 'Ekran seçimi iptal edildi.',
    },
    {
      label: 'picker başarısız olduğunda',
      failure: new Error('picker failed'),
      errorCode: 'start_failed',
      message: 'Ekran paylaşımı başlatılamadı.',
    },
  ] as const)(
    '$label eski canlı paylaşımı görünür durumda tutar',
    async ({ failure, errorCode, message }) => {
      const { stream, stop } = createDisplayStream()
      const getDisplayMedia = vi
        .fn()
        .mockResolvedValueOnce(stream)
        .mockRejectedValueOnce(failure)
      vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } })

      const initial = useRenderScreenShare()
      await expect(initial.start()).resolves.toBe(true)

      const sharing = useRenderScreenShare()
      expect(sharing.status).toBe('sharing')
      expect(sharing.stream).toBe(stream)

      const replacement = sharing.start()
      expect(useRenderScreenShare().status).toBe('requesting')
      await expect(replacement).resolves.toBe(false)

      const recovered = useRenderScreenShare()
      expect(recovered.status).toBe('sharing')
      expect(recovered.stream).toBe(stream)
      expect(recovered.errorCode).toBe(errorCode)
      expect(recovered.error).toBe(message)
      expect(stop).not.toHaveBeenCalled()
    },
  )
})
