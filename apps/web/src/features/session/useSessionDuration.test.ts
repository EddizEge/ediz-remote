import { describe, expect, it } from 'vitest'
import { formatSessionDuration } from './useSessionDuration'

describe('session duration', () => {
  it('formats a stable hour-minute-second status value', () => {
    expect(formatSessionDuration(0)).toBe('00:00:00')
    expect(formatSessionDuration(65)).toBe('00:01:05')
    expect(formatSessionDuration(7_325)).toBe('02:02:05')
    expect(formatSessionDuration(-1)).toBe('00:00:00')
  })
})
