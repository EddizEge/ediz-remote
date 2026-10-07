import { describe, expect, it } from 'vitest'
import {
  combineDesktopErrors,
  mergeDesktopErrorScope,
  parseControlState,
  parseDesktopCursorState,
  parseDesktopDisplayState,
  parseDesktopStatus,
  type DesktopErrorScopes,
} from './useDesktopBridge'

describe('desktop display bridge', () => {
  it('accepts a bounded monitor list and selected monitor', () => {
    expect(parseDesktopStatus({
      type: 'desktop.status',
      payload: {
        captureAvailable: true,
        displayCount: 2,
        selectedDisplayId: '\\\\.\\DISPLAY2',
        qualityProfile: 'quality',
        displays: [
          {
            id: '\\\\.\\DISPLAY1',
            label: 'Ekran 1 (Ana ekran)',
            width: 1920,
            height: 1080,
            isPrimary: true,
          },
          {
            id: '\\\\.\\DISPLAY2',
            label: 'Ekran 2',
            width: 2560,
            height: 1440,
            isPrimary: false,
          },
        ],
      },
    })?.payload).toMatchObject({
      selectedDisplayId: '\\\\.\\DISPLAY2',
      qualityProfile: 'quality',
    })
  })

  it('rejects malformed or oversized monitor data', () => {
    expect(parseDesktopStatus({
      type: 'desktop.status',
      payload: {
        displays: [{ id: 'display', label: 'Ekran', width: 0, height: 1080 }],
      },
    })).toBeNull()
    expect(parseDesktopStatus({
      type: 'desktop.status',
      payload: { displays: Array.from({ length: 17 }, () => ({})) },
    })).toBeNull()
    expect(parseDesktopStatus({
      type: 'desktop.status',
      payload: { qualityProfile: 'unbounded' },
    })).toBeNull()
  })

  it('replaces native diagnostic details with a fixed safe message', () => {
    const status = parseDesktopStatus({
      type: 'desktop.status',
      payload: {
        captureAvailable: false,
        displayCount: 0,
        error: 'candidate=10.0.0.4 token=secret C:\\private\\driver.dll',
      },
    })
    expect(status?.payload.error).toBe('Windows bileşenlerinden biri hazırlanamadı.')
    expect(JSON.stringify(status)).not.toContain('secret')
  })

  it('accepts only allowlisted native error codes and maps them to fixed text', () => {
    expect(parseDesktopStatus({
      type: 'desktop.status',
      payload: { encoderAvailable: false, encoderErrorCode: 'encoder_failed' },
    })?.payload.error).toBe('Windows bileşenlerinden biri hazırlanamadı.')
    expect(parseDesktopStatus({
      type: 'desktop.status',
      payload: { errorCode: 'candidate=private&token=secret' },
    })).toBeNull()
    expect(parseDesktopDisplayState({
      type: 'desktop.display.state',
      payload: { switching: false, errorCode: 'display_switch_failed' },
    })?.payload.error).toBe('Seçilen ekrana geçilemedi.')
    expect(parseControlState({
      type: 'desktop.control.state',
      payload: { active: false, errorCode: 'control_input_failed' },
    })?.payload.error).toBe('Uzaktan kontrol bileşeni hazırlanamadı.')
  })

  it('does not preserve oversized legacy diagnostic text in parsed state', () => {
    const status = parseDesktopStatus({
      type: 'desktop.status',
      payload: { error: `secret-${'x'.repeat(2_000)}` },
    })
    expect(status?.payload.error).toBe('Windows bileşenlerinden biri hazırlanamadı.')
    expect(JSON.stringify(status)).not.toContain('secret')
  })

  it('accepts null optional fields emitted by System.Text.Json', () => {
    expect(parseDesktopStatus({
      type: 'desktop.status',
      payload: {
        captureAvailable: false,
        displayCount: 0,
        selectedDisplayId: null,
        encoderName: null,
        encoderError: null,
        gpuInputError: null,
        controlInputError: null,
      },
    })).not.toBeNull()
  })

  it('does not clear a component failure when another desktop scope succeeds', () => {
    const componentFailure: DesktopErrorScopes = {
      component: 'Windows bileşenlerinden biri hazırlanamadı.',
      display: 'Seçilen ekrana geçilemedi.',
      quality: null,
      control: null,
    }
    const afterDisplaySuccess = mergeDesktopErrorScope(
      componentFailure,
      'display',
      null,
    )
    expect(combineDesktopErrors(afterDisplaySuccess)).toBe(
      'Windows bileşenlerinden biri hazırlanamadı.',
    )
  })

  it('validates bounded native cursor metadata', () => {
    expect(parseDesktopCursorState({
      type: 'desktop.cursor.state',
      payload: { sequence: 12, x: 0.25, y: 0.75, visible: true },
    })?.payload).toEqual({ sequence: 12, x: 0.25, y: 0.75, visible: true })
    expect(parseDesktopCursorState({
      type: 'desktop.cursor.state',
      payload: { sequence: 13, x: -0.1, y: 0.5, visible: true },
    })).toBeNull()
    expect(parseDesktopCursorState({
      type: 'desktop.cursor.state',
      payload: { sequence: 14, x: 0.5, y: 0.5, visible: 'yes' },
    })).toBeNull()
  })
})
