import { useEffect, useRef, useState } from 'react'

type SessionState = 'idle' | 'waiting' | 'joining' | 'active' | 'recovering'

export function useSessionDuration(sessionState: SessionState): number {
  const ongoing = sessionState === 'active' || sessionState === 'recovering'
  const startedAtRef = useRef<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (!ongoing) {
      startedAtRef.current = null
      setElapsedSeconds(0)
      return
    }

    startedAtRef.current ??= Date.now()
    const update = () => {
      const startedAt = startedAtRef.current
      if (startedAt !== null) {
        setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)))
      }
    }
    update()
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  }, [ongoing])

  return elapsedSeconds
}

export function formatSessionDuration(totalSeconds: number): string {
  const bounded = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(bounded / 3_600)
  const minutes = Math.floor((bounded % 3_600) / 60)
  const seconds = bounded % 60
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}
