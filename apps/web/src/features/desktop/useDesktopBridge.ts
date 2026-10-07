import { useCallback, useEffect, useRef, useState } from 'react'

interface DesktopRuntimeConfiguration {
  desktop?: boolean
  signalingUrl?: string
  version?: string
}

interface DesktopStatusMessage {
  type: 'desktop.status'
  payload: {
    version?: string
    captureAvailable?: boolean
    displayCount?: number
    displays?: DesktopDisplay[]
    selectedDisplayId?: string
    qualityProfile?: DesktopQualityProfile
    encoderAvailable?: boolean
    encoderName?: string
    codec?: string
    encoderError?: string
    encoderErrorCode?: DesktopErrorCode
    gpuInputReady?: boolean
    gpuInputError?: string
    gpuInputErrorCode?: DesktopErrorCode
    controlInputAvailable?: boolean
    controlInputError?: string
    controlInputErrorCode?: DesktopErrorCode
    emergencyStopShortcut?: string
    error?: string
    errorCode?: DesktopErrorCode
  }
}

interface DesktopDisplayStateMessage {
  type: 'desktop.display.state'
  payload: {
    selectedDisplayId?: string
    switching?: boolean
    error?: string
    errorCode?: DesktopErrorCode
  }
}

interface DesktopQualityStateMessage {
  type: 'desktop.quality.state'
  payload: {
    profile: DesktopQualityProfile
    switching?: boolean
    error?: string
    errorCode?: DesktopErrorCode
  }
}

export interface DesktopCursorState {
  sequence: number
  x: number
  y: number
  visible: boolean
}

interface DesktopCursorStateMessage {
  type: 'desktop.cursor.state'
  payload: DesktopCursorState
}

export type DesktopQualityProfile = 'auto' | 'speed' | 'quality'

export type DesktopErrorCode =
  | 'initialization_failed'
  | 'navigation_failed'
  | 'capture_failed'
  | 'encoder_failed'
  | 'gpu_input_failed'
  | 'control_input_failed'
  | 'display_switch_failed'
  | 'quality_switch_failed'
  | 'native_video_failed'

export interface DesktopDisplay {
  id: string
  label: string
  width: number
  height: number
  isPrimary: boolean
}

interface DesktopControlStateMessage {
  type: 'desktop.control.state'
  payload: {
    active?: boolean
    available?: boolean
    shortcut?: string
    error?: string
    errorCode?: DesktopErrorCode
  }
}

interface DesktopEmergencyStopMessage {
  type: 'desktop.control.emergency-stopped'
  payload: {
    shortcut?: string
  }
}

export interface DesktopWebView {
  postMessage: (message: unknown) => void
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void
  removeEventListener: (
    type: 'message',
    listener: (event: MessageEvent) => void,
  ) => void
}

type DesktopWindow = Window & {
  __EDIZ_REMOTE_CONFIG__?: DesktopRuntimeConfiguration
  chrome?: { webview?: DesktopWebView }
}

export interface DesktopBridgeState {
  isDesktop: boolean
  captureAvailable: boolean
  displayCount: number
  displays: DesktopDisplay[]
  selectedDisplayId: string | null
  displaySwitching: boolean
  qualityProfile: DesktopQualityProfile
  qualitySwitching: boolean
  encoderAvailable: boolean
  encoderName: string | null
  codec: string | null
  gpuInputReady: boolean
  controlInputAvailable: boolean
  controlActive: boolean
  emergencyStopShortcut: string
  emergencyStopCount: number
  version: string | null
  error: string | null
}

export interface DesktopErrorScopes {
  component: string | null
  display: string | null
  quality: string | null
  control: string | null
}

type DesktopErrorScope = keyof DesktopErrorScopes

export interface DesktopBridgeController extends DesktopBridgeState {
  selectDisplay: (displayId: string) => boolean
  selectQualityProfile: (profile: DesktopQualityProfile) => boolean
  retry: () => boolean
}

const BROWSER_STATE: DesktopBridgeState = {
  isDesktop: false,
  captureAvailable: false,
  displayCount: 0,
  displays: [],
  selectedDisplayId: null,
  displaySwitching: false,
  qualityProfile: 'auto',
  qualitySwitching: false,
  encoderAvailable: false,
  encoderName: null,
  codec: null,
  gpuInputReady: false,
  controlInputAvailable: false,
  controlActive: false,
  emergencyStopShortcut: 'Ctrl+Alt+Shift+F12',
  emergencyStopCount: 0,
  version: null,
  error: null,
}

const EMPTY_ERROR_SCOPES: DesktopErrorScopes = {
  component: null,
  display: null,
  quality: null,
  control: null,
}

export function mergeDesktopErrorScope(
  current: DesktopErrorScopes,
  scope: DesktopErrorScope,
  error: string | null,
): DesktopErrorScopes {
  return { ...current, [scope]: error }
}

export function combineDesktopErrors(scopes: DesktopErrorScopes): string | null {
  return (
    scopes.component ??
    scopes.display ??
    scopes.quality ??
    scopes.control ??
    null
  )
}

export function useDesktopBridge(): DesktopBridgeController {
  const errorScopesRef = useRef<DesktopErrorScopes>({ ...EMPTY_ERROR_SCOPES })
  const [state, setState] = useState<DesktopBridgeState>(() => {
    const runtime = getRuntimeConfiguration()
    return runtime.desktop
      ? { ...BROWSER_STATE, isDesktop: true, version: runtime.version ?? null }
      : BROWSER_STATE
  })

  useEffect(() => {
    const webView = getDesktopWebView()
    if (!webView) return

    const handleMessage = (event: MessageEvent) => {
      const status = parseDesktopStatus(event.data)
      if (status) {
        errorScopesRef.current = mergeDesktopErrorScope(
          errorScopesRef.current,
          'component',
          status.payload.error ?? null,
        )
        setState((current) => ({
          ...current,
          isDesktop: true,
          captureAvailable: status.payload.captureAvailable === true,
          displayCount: status.payload.displayCount ?? 0,
          displays: status.payload.displays ?? [],
          selectedDisplayId:
            status.payload.selectedDisplayId ?? current.selectedDisplayId,
          displaySwitching: false,
          qualityProfile:
            status.payload.qualityProfile ?? current.qualityProfile,
          qualitySwitching: false,
          encoderAvailable: status.payload.encoderAvailable === true,
          encoderName: status.payload.encoderName ?? null,
          codec: status.payload.codec ?? null,
          gpuInputReady: status.payload.gpuInputReady === true,
          controlInputAvailable: status.payload.controlInputAvailable === true,
          emergencyStopShortcut:
            status.payload.emergencyStopShortcut ?? current.emergencyStopShortcut,
          version: status.payload.version ?? null,
          error: combineDesktopErrors(errorScopesRef.current),
        }))
        return
      }

      const displayState = parseDesktopDisplayState(event.data)
      if (displayState) {
        errorScopesRef.current = mergeDesktopErrorScope(
          errorScopesRef.current,
          'display',
          displayState.payload.error ?? null,
        )
        setState((current) => ({
          ...current,
          selectedDisplayId:
            displayState.payload.selectedDisplayId ?? current.selectedDisplayId,
          displaySwitching: displayState.payload.switching === true,
          error: combineDesktopErrors(errorScopesRef.current),
        }))
        return
      }

      const qualityState = parseDesktopQualityState(event.data)
      if (qualityState) {
        errorScopesRef.current = mergeDesktopErrorScope(
          errorScopesRef.current,
          'quality',
          qualityState.payload.error ?? null,
        )
        setState((current) => ({
          ...current,
          qualityProfile: qualityState.payload.profile,
          qualitySwitching: qualityState.payload.switching === true,
          error: combineDesktopErrors(errorScopesRef.current),
        }))
        return
      }

      const controlState = parseControlState(event.data)
      if (controlState) {
        errorScopesRef.current = mergeDesktopErrorScope(
          errorScopesRef.current,
          'control',
          controlState.payload.error ?? null,
        )
        setState((current) => ({
          ...current,
          controlActive: controlState.payload.active === true,
          controlInputAvailable:
            controlState.payload.available ?? current.controlInputAvailable,
          emergencyStopShortcut:
            controlState.payload.shortcut ?? current.emergencyStopShortcut,
          error: combineDesktopErrors(errorScopesRef.current),
        }))
        return
      }

      const emergencyStop = parseEmergencyStop(event.data)
      if (emergencyStop) {
        setState((current) => ({
          ...current,
          controlActive: false,
          emergencyStopShortcut:
            emergencyStop.payload.shortcut ?? current.emergencyStopShortcut,
          emergencyStopCount: current.emergencyStopCount + 1,
        }))
      }
    }

    webView.addEventListener('message', handleMessage)
    webView.postMessage({ type: 'desktop.initialize' })
    return () => webView.removeEventListener('message', handleMessage)
  }, [])

  const selectDisplay = useCallback((displayId: string): boolean => {
    if (!state.displays.some((display) => display.id === displayId)) return false
    const sent = postDesktopMessage({
      type: 'desktop.display.select',
      displayId,
    })
    if (sent) {
      setState((current) => ({
        ...current,
        selectedDisplayId: displayId,
        displaySwitching: true,
      }))
    }
    return sent
  }, [state.displays])

  const selectQualityProfile = useCallback(
    (profile: DesktopQualityProfile): boolean => {
      if (!isQualityProfile(profile)) return false
      const sent = postDesktopMessage({
        type: 'desktop.quality.select',
        profile,
      })
      if (sent) {
        setState((current) => ({
          ...current,
          qualityProfile: profile,
          qualitySwitching: true,
        }))
      }
      return sent
    },
    [],
  )

  const retry = useCallback((): boolean => {
    const sent = postDesktopMessage({ type: 'desktop.initialize' })
    if (sent) {
      errorScopesRef.current = { ...EMPTY_ERROR_SCOPES }
      setState((current) => ({
        ...current,
        displaySwitching: false,
        qualitySwitching: false,
        error: null,
      }))
    }
    return sent
  }, [])

  return { ...state, selectDisplay, selectQualityProfile, retry }
}

export function getRuntimeConfiguration(): DesktopRuntimeConfiguration {
  return (window as DesktopWindow).__EDIZ_REMOTE_CONFIG__ ?? {}
}

export function postDesktopMessage(message: unknown): boolean {
  const webView = getDesktopWebView()
  if (!webView) return false
  webView.postMessage(message)
  return true
}

export function subscribeToDesktopMessages(
  listener: (event: MessageEvent) => void,
): () => void {
  const webView = getDesktopWebView()
  if (!webView) return () => undefined
  webView.addEventListener('message', listener)
  return () => webView.removeEventListener('message', listener)
}

function getDesktopWebView(): DesktopWebView | null {
  return (window as DesktopWindow).chrome?.webview ?? null
}

export function parseDesktopStatus(value: unknown): DesktopStatusMessage | null {
  if (!isRecord(value) || value.type !== 'desktop.status' || !isRecord(value.payload)) {
    return null
  }
  const payload = value.payload
  const displays = parseDisplays(payload.displays)
  if (payload.displays !== undefined && displays === null) return null
  const selectedDisplayId = optionalString(payload.selectedDisplayId, 128)
  if (!isAbsent(payload.selectedDisplayId) && selectedDisplayId === null) {
    return null
  }
  if (
    payload.qualityProfile !== undefined &&
    !isQualityProfile(payload.qualityProfile)
  ) {
    return null
  }
  for (const field of [
    payload.captureAvailable,
    payload.encoderAvailable,
    payload.gpuInputReady,
    payload.controlInputAvailable,
  ]) {
    if (field !== undefined && typeof field !== 'boolean') return null
  }
  if (
    payload.displayCount !== undefined &&
    (!Number.isInteger(payload.displayCount) ||
      (payload.displayCount as number) < 0 ||
      (payload.displayCount as number) > 16)
  ) {
    return null
  }
  const version = optionalString(payload.version, 64)
  const encoderName = optionalString(payload.encoderName, 256)
  const codec = optionalString(payload.codec, 32)
  const emergencyStopShortcut = optionalString(payload.emergencyStopShortcut, 64)
  for (const [raw, parsed] of [
    [payload.version, version],
    [payload.encoderName, encoderName],
    [payload.codec, codec],
    [payload.emergencyStopShortcut, emergencyStopShortcut],
  ]) {
    if (!isAbsent(raw) && parsed === null) return null
  }
  const rawErrors = [
    payload.error,
    payload.controlInputError,
    payload.gpuInputError,
    payload.encoderError,
  ]
  if (rawErrors.some((item) => !isAbsent(item) && typeof item !== 'string')) {
    return null
  }
  const errorCodes = [
    payload.errorCode,
    payload.controlInputErrorCode,
    payload.gpuInputErrorCode,
    payload.encoderErrorCode,
  ]
  if (errorCodes.some((item) => !isAbsent(item) && !isDesktopErrorCode(item))) {
    return null
  }
  return {
    type: 'desktop.status',
    payload: {
      version: version ?? undefined,
      captureAvailable: payload.captureAvailable as boolean | undefined,
      displayCount: payload.displayCount as number | undefined,
      displays: displays ?? undefined,
      selectedDisplayId: selectedDisplayId ?? undefined,
      qualityProfile: isQualityProfile(payload.qualityProfile)
        ? payload.qualityProfile
        : undefined,
      encoderAvailable: payload.encoderAvailable as boolean | undefined,
      encoderName: encoderName ?? undefined,
      codec: codec ?? undefined,
      gpuInputReady: payload.gpuInputReady as boolean | undefined,
      controlInputAvailable: payload.controlInputAvailable as boolean | undefined,
      emergencyStopShortcut: emergencyStopShortcut ?? undefined,
      error:
        rawErrors.some((item) => typeof item === 'string') ||
        errorCodes.some(isDesktopErrorCode)
        ? 'Windows bileşenlerinden biri hazırlanamadı.'
        : undefined,
    },
  }
}

export function parseDesktopDisplayState(
  value: unknown,
): DesktopDisplayStateMessage | null {
  if (
    !isRecord(value) ||
    value.type !== 'desktop.display.state' ||
    !isRecord(value.payload)
  ) {
    return null
  }
  const selectedDisplayId = optionalString(value.payload.selectedDisplayId, 128)
  if (!isAbsent(value.payload.selectedDisplayId) && selectedDisplayId === null) {
    return null
  }
  if (
    value.payload.switching !== undefined &&
    typeof value.payload.switching !== 'boolean'
  ) {
    return null
  }
  const hasLegacyError = typeof value.payload.error === 'string'
  if (!isAbsent(value.payload.error) && !hasLegacyError) return null
  const errorCode = value.payload.errorCode
  if (!isAbsent(errorCode) && errorCode !== 'display_switch_failed') return null
  return {
    type: value.type,
    payload: {
      selectedDisplayId: selectedDisplayId ?? undefined,
      switching: value.payload.switching,
      error:
        hasLegacyError || errorCode === 'display_switch_failed'
          ? 'Seçilen ekrana geçilemedi.'
          : undefined,
    },
  }
}

export function parseDesktopQualityState(
  value: unknown,
): DesktopQualityStateMessage | null {
  if (
    !isRecord(value) ||
    value.type !== 'desktop.quality.state' ||
    !isRecord(value.payload) ||
    !isQualityProfile(value.payload.profile) ||
    (value.payload.switching !== undefined &&
      typeof value.payload.switching !== 'boolean')
  ) {
    return null
  }
  const hasLegacyError = typeof value.payload.error === 'string'
  if (!isAbsent(value.payload.error) && !hasLegacyError) return null
  const errorCode = value.payload.errorCode
  if (!isAbsent(errorCode) && errorCode !== 'quality_switch_failed') return null
  return {
    type: value.type,
    payload: {
      profile: value.payload.profile,
      switching: value.payload.switching,
      error:
        hasLegacyError || errorCode === 'quality_switch_failed'
          ? 'Görüntü kalitesi değiştirilemedi.'
          : undefined,
    },
  }
}

export function parseDesktopCursorState(
  value: unknown,
): DesktopCursorStateMessage | null {
  if (
    !isRecord(value) ||
    value.type !== 'desktop.cursor.state' ||
    !isRecord(value.payload) ||
    !Number.isSafeInteger(value.payload.sequence) ||
    (value.payload.sequence as number) < 0 ||
    !isNormalizedCoordinate(value.payload.x) ||
    !isNormalizedCoordinate(value.payload.y) ||
    typeof value.payload.visible !== 'boolean'
  ) {
    return null
  }
  return {
    type: value.type,
    payload: {
      sequence: value.payload.sequence as number,
      x: value.payload.x as number,
      y: value.payload.y as number,
      visible: value.payload.visible,
    },
  }
}

export function parseControlState(value: unknown): DesktopControlStateMessage | null {
  if (
    !isRecord(value) ||
    value.type !== 'desktop.control.state' ||
    !isRecord(value.payload)
  ) {
    return null
  }
  const payload = value.payload
  if (
    (payload.active !== undefined && typeof payload.active !== 'boolean') ||
    (payload.available !== undefined && typeof payload.available !== 'boolean')
  ) {
    return null
  }
  const shortcut = optionalString(payload.shortcut, 64)
  const hasLegacyError = typeof payload.error === 'string'
  const errorCode = payload.errorCode
  if (
    (!isAbsent(payload.shortcut) && shortcut === null) ||
    (!isAbsent(payload.error) && !hasLegacyError) ||
    (!isAbsent(errorCode) && errorCode !== 'control_input_failed')
  ) {
    return null
  }
  return {
    type: value.type,
    payload: {
      active: payload.active as boolean | undefined,
      available: payload.available as boolean | undefined,
      shortcut: shortcut ?? undefined,
      error:
        hasLegacyError || errorCode === 'control_input_failed'
          ? 'Uzaktan kontrol bileşeni hazırlanamadı.'
          : undefined,
    },
  }
}

function parseEmergencyStop(value: unknown): DesktopEmergencyStopMessage | null {
  if (
    !isRecord(value) ||
    value.type !== 'desktop.control.emergency-stopped' ||
    !isRecord(value.payload)
  ) {
    return null
  }
  const shortcut = optionalString(value.payload.shortcut, 64)
  if (!isAbsent(value.payload.shortcut) && shortcut === null) return null
  return {
    type: value.type,
    payload: { shortcut: shortcut ?? undefined },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNormalizedCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function parseDisplays(value: unknown): DesktopDisplay[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16) return null
  const displays: DesktopDisplay[] = []
  for (const item of value) {
    if (!isRecord(item)) return null
    const id = optionalString(item.id, 128)
    const label = optionalString(item.label, 128)
    if (
      !id ||
      !label ||
      !Number.isInteger(item.width) ||
      !Number.isInteger(item.height) ||
      (item.width as number) < 1 ||
      (item.height as number) < 1 ||
      (item.width as number) > 16_384 ||
      (item.height as number) > 16_384 ||
      typeof item.isPrimary !== 'boolean'
    ) {
      return null
    }
    displays.push({
      id,
      label,
      width: item.width as number,
      height: item.height as number,
      isPrimary: item.isPrimary,
    })
  }
  return displays
}

function optionalString(value: unknown, maximumLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
    ? value
    : null
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

function isQualityProfile(value: unknown): value is DesktopQualityProfile {
  return value === 'auto' || value === 'speed' || value === 'quality'
}

function isDesktopErrorCode(value: unknown): value is DesktopErrorCode {
  return (
    value === 'initialization_failed' ||
    value === 'navigation_failed' ||
    value === 'capture_failed' ||
    value === 'encoder_failed' ||
    value === 'gpu_input_failed' ||
    value === 'control_input_failed' ||
    value === 'display_switch_failed' ||
    value === 'quality_switch_failed' ||
    value === 'native_video_failed'
  )
}
