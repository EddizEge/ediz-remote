import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import type { IceConfiguration } from '@ediz-remote/protocol'
import {
  ArrowRightIcon,
  ClockIcon,
  CopyIcon,
  InfoIcon,
  LinkIcon,
  LockIcon,
  MonitorIcon,
  NetworkIcon,
  RefreshIcon,
  SettingsIcon,
  XIcon,
} from './components/Icons'
import { useSignaling } from './features/session/useSignaling'
import {
  resolveUserFacingIssue,
  type ScreenShareIssueCode,
  type UserFacingIssue,
} from './features/session/userFacingIssue'
import {
  formatSessionDuration,
  useSessionDuration,
} from './features/session/useSessionDuration'
import { useDesktopBridge } from './features/desktop/useDesktopBridge'
import type {
  QualityProfile,
  MediaState,
  SessionDisplay,
} from './features/webrtc/peerProtocol'
import { RemoteViewer } from './features/webrtc/RemoteViewer'
import { usePeerConnection } from './features/webrtc/usePeerConnection'
import { useNativeVideoPeer } from './features/webrtc/useNativeVideoPeer'
import { useScreenShare } from './features/webrtc/useScreenShare'
import './App.css'

function App() {
  const desktop = useDesktopBridge()
  const desktopIsDesktop = desktop.isDesktop
  const selectDesktopQualityProfile = desktop.selectQualityProfile
  const signaling = useSignaling()
  const sessionDuration = useSessionDuration(signaling.sessionState)
  const revokeControl = signaling.revokeControl
  const [browserQualityProfile, setBrowserQualityProfile] =
    useState<QualityProfile>('auto')
  const activeQualityProfile = desktopIsDesktop
    ? desktop.qualityProfile
    : browserQualityProfile
  const {
    stream: localScreenStream,
    status: screenShareStatus,
    errorCode: screenShareErrorCode,
    start: startScreenShare,
    stop: stopScreenShare,
  } = useScreenShare(activeQualityProfile)
  const localDisplays = useMemo<SessionDisplay[]>(
    () => desktop.displays.map((display) => ({
      id: display.id,
      label: display.label,
      width: display.width,
      height: display.height,
    })),
    [desktop.displays],
  )
  const handleQualityProfileSelect = useCallback(
    (profile: QualityProfile): boolean => {
      if (desktopIsDesktop) return selectDesktopQualityProfile(profile)
      setBrowserQualityProfile(profile)
      return true
    },
    [desktopIsDesktop, selectDesktopQualityProfile],
  )
  const nativeVideo = useNativeVideoPeer({
    enabled: signaling.sessionState === 'active',
    sessionState: signaling.sessionState,
    role: signaling.sessionRole,
    iceConfiguration: signaling.iceConfiguration,
    iceResetVersion: signaling.iceResetVersion,
    sendSignal: signaling.sendSignal,
    subscribeToSignals: signaling.subscribeToSignals,
    requestIceRefresh: signaling.requestIceRefresh,
  })
  const localMediaState = resolveLocalMediaState(
    signaling.sessionState,
    signaling.sessionRole,
    desktopIsDesktop,
    nativeVideo.status,
    screenShareStatus,
    screenShareErrorCode,
  )
  const peerConnection = usePeerConnection({
    enabled: signaling.sessionState === 'active',
    sessionState: signaling.sessionState,
    role: signaling.sessionRole,
    localStream: localScreenStream,
    controlAllowed: signaling.accessMode === 'control',
    iceConfiguration: signaling.iceConfiguration,
    iceResetVersion: signaling.iceResetVersion,
    sendSignal: signaling.sendSignal,
    subscribeToSignals: signaling.subscribeToSignals,
    requestIceRefresh: signaling.requestIceRefresh,
    localDisplays,
    selectedDisplayId: desktop.selectedDisplayId,
    onDisplaySelect: desktop.selectDisplay,
    localQualityProfile: activeQualityProfile,
    onQualityProfileSelect: handleQualityProfileSelect,
    localMediaState,
  })
  const retryDesktop = desktop.retry
  const retryPeerConnection = peerConnection.retry
  const retryNativeVideo = nativeVideo.retry
  const clearSignalingError = signaling.clearError
  const createSession = signaling.createSession
  const requestIceRefresh = signaling.requestIceRefresh
  const retrySignalingConnection = signaling.retryConnection
  const [joinCode, setJoinCode] = useState('')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const joinInputRef = useRef<HTMLInputElement>(null)
  const formattedSessionCode = useMemo(
    () => formatCode(signaling.sessionCode),
    [signaling.sessionCode],
  )
  const hostControlActive =
    signaling.sessionState === 'active' &&
    signaling.sessionRole === 'host' &&
    peerConnection.controlGranted
  const userFacingIssue = useMemo(
    () => resolveUserFacingIssue({
      connectionStatus: signaling.connectionStatus,
      sessionState: signaling.sessionState,
      sessionRole: signaling.sessionRole,
      signalingErrorCode: signaling.errorCode,
      peerStatus: peerConnection.status,
      nativeVideoStatus: nativeVideo.status,
      fallbackScreenActive: Boolean(peerConnection.remoteStream),
      remoteMediaState: peerConnection.remoteMediaState,
      desktopHasError: Boolean(desktop.error),
      screenShareErrorCode,
      screenShareActive: screenShareStatus === 'sharing',
    }),
    [
      desktop.error,
      nativeVideo.status,
      peerConnection.remoteStream,
      peerConnection.remoteMediaState,
      peerConnection.status,
      screenShareErrorCode,
      screenShareStatus,
      signaling.connectionStatus,
      signaling.errorCode,
      signaling.sessionRole,
      signaling.sessionState,
    ],
  )

  const handleRecoveryAction = useCallback(() => {
    const action = userFacingIssue?.action
    if (!action) return
    if (action === 'retry-signaling') {
      retrySignalingConnection()
    } else if (action === 'edit-code') {
      clearSignalingError()
      setJoinCode('')
      window.requestAnimationFrame(() => joinInputRef.current?.focus())
    } else if (action === 'new-code') {
      setJoinCode('')
      createSession()
    } else if (action === 'retry-session') {
      if (signaling.sessionRole !== 'host') return
      clearSignalingError()
      const awaitIceRefresh = requestIceRefresh()
      retryPeerConnection({ awaitIceRefresh })
      retryNativeVideo({ awaitIceRefresh })
    } else if (action === 'retry-video') {
      if (signaling.sessionRole !== 'host') return
      clearSignalingError()
      retryNativeVideo({ awaitIceRefresh: requestIceRefresh() })
    } else if (action === 'retry-desktop') {
      retryDesktop()
      if (
        signaling.sessionState === 'active' &&
        signaling.sessionRole === 'host'
      ) {
        retryNativeVideo()
      }
    } else if (action === 'retry-screen-share') {
      void startScreenShare()
    }
  }, [
    clearSignalingError,
    createSession,
    requestIceRefresh,
    retryDesktop,
    retryNativeVideo,
    retryPeerConnection,
    retrySignalingConnection,
    signaling.sessionRole,
    signaling.sessionState,
    startScreenShare,
    userFacingIssue?.action,
  ])

  useEffect(() => {
    if (
      (!['active', 'recovering'].includes(signaling.sessionState) ||
        signaling.sessionRole !== 'host') &&
      screenShareStatus !== 'idle'
    ) {
      stopScreenShare()
    }
  }, [
    screenShareStatus,
    stopScreenShare,
    signaling.sessionRole,
    signaling.sessionState,
  ])

  useEffect(() => setCopyStatus('idle'), [signaling.sessionCode])

  useEffect(() => {
    if (
      desktop.emergencyStopCount > 0 &&
      signaling.sessionState === 'active' &&
      signaling.sessionRole === 'host'
    ) {
      revokeControl()
    }
  }, [
    desktop.emergencyStopCount,
    revokeControl,
    signaling.sessionRole,
    signaling.sessionState,
  ])

  const handleJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (joinCode.length === 6) signaling.joinSession(joinCode)
  }

  const copyCode = async () => {
    if (!signaling.sessionCode) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(signaling.sessionCode)
      setCopyStatus('copied')
      window.setTimeout(() => setCopyStatus('idle'), 1_500)
    } catch {
      setCopyStatus('failed')
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <BrandMark />
          <div>
            <strong>Ediz Remote</strong>
            <span>
              {desktop.isDesktop
                ? 'Windows masaüstü uygulaması'
                : 'Güvenli uzaktan bağlantı'}
            </span>
          </div>
        </div>
        <div className="header-actions" aria-label="Uygulama seçenekleri">
          {desktop.isDesktop ? (
            <span
              className={`desktop-status${desktop.captureAvailable ? ' desktop-status--ready' : ''}`}
              data-testid="desktop-status"
              title={desktop.encoderName ?? undefined}
            >
              <MonitorIcon />
              {desktop.captureAvailable
                ? `${desktop.displayCount} ekran · ${desktop.gpuInputReady ? `${desktop.codec} GPU` : 'codec bekleniyor'}`
                : 'Native hazırlanıyor'}
            </span>
          ) : null}
          <button className="icon-button" type="button" aria-label="Ayarlar">
            <SettingsIcon />
          </button>
          <button className="icon-button" type="button" aria-label="Hakkında">
            <InfoIcon />
          </button>
        </div>
      </header>

      <div className="status-region">
        <div className="service-bar" role="status" aria-live="polite">
          <span
            className={`status-dot status-dot--${signaling.connectionStatus}`}
            aria-hidden="true"
          />
          <span>{connectionText(signaling.connectionStatus)}</span>
        </div>

        {hostControlActive ? (
          <div className="control-active-banner" role="status">
            <LockIcon />
            <strong>Kontrol aktif</strong>
            <span>
              Acil durdurma: {desktop.emergencyStopShortcut}
              {desktop.isDesktop && !desktop.controlActive
                ? ' · Native giriş hazırlanıyor'
                : ''}
            </span>
          </div>
        ) : null}

        {userFacingIssue ? (
          <RecoveryNotice
            issue={userFacingIssue}
            onAction={handleRecoveryAction}
          />
        ) : null}
      </div>

      {signaling.sessionState === 'recovering' ? (
        <section className="recovery-panel" role="status" aria-live="polite">
          <RefreshIcon />
          <div>
            <h1>Bağlantı kurtarılıyor</h1>
            <p>
              Oturum onayı korunuyor. Ağ geri geldiğinde güvenli bağlantı ve
              ekran aktarımı otomatik olarak yeniden kurulacak.
            </p>
            <small>{signaling.activity}</small>
          </div>
        </section>
      ) : signaling.sessionState === 'active' &&
        signaling.sessionRole === 'guest' ? (
        <section className="active-session active-session--guest">
          <SessionOverview
            role="guest"
            peerConnection={peerConnection}
            nativeVideo={nativeVideo}
            displays={peerConnection.remoteDisplays}
            selectedDisplayId={peerConnection.remoteSelectedDisplayId}
            onDisplaySelect={peerConnection.selectRemoteDisplay}
            qualityProfile={peerConnection.remoteQualityProfile}
            onQualityProfileSelect={peerConnection.selectQualityProfile}
            sessionDuration={sessionDuration}
          />
          <RemoteViewer
            stream={nativeVideo.remoteStream ?? peerConnection.remoteStream}
            sharing={Boolean(nativeVideo.remoteStream) || peerConnection.remoteScreenActive}
            controlGranted={peerConnection.controlGranted}
            sendControlEvent={peerConnection.sendControlEvent}
            subscribeToRemoteCursor={peerConnection.subscribeToRemoteCursor}
          />
        </section>
      ) : signaling.sessionState === 'active' &&
        signaling.sessionRole === 'host' ? (
        <section className="active-session active-session--host">
          <SessionOverview
            role="host"
            peerConnection={peerConnection}
            nativeVideo={nativeVideo}
            displays={localDisplays}
            selectedDisplayId={desktop.selectedDisplayId}
            displaySwitching={desktop.displaySwitching}
            onDisplaySelect={desktop.selectDisplay}
            qualityProfile={activeQualityProfile}
            qualitySwitching={desktop.qualitySwitching}
            onQualityProfileSelect={handleQualityProfileSelect}
            sessionDuration={sessionDuration}
          />
          <div className="host-session-body">
            <div className="host-session-message">
              <span className="host-session-message__icon"><MonitorIcon /></span>
              <div>
                <h1>Ekranınız destek veren kişiye açık</h1>
                <p>
                  {signaling.accessMode === 'control'
                    ? 'Görüntüleme ve kontrol izni verdiniz. İzni istediğiniz an geri alabilirsiniz.'
                    : 'Yalnızca görüntüleme izni verdiniz. Bu cihaz uzaktan kontrol edilemez.'}
                </p>
              </div>
            </div>
            {!desktop.isDesktop ? (
              <button
                className="screen-share-button"
                type="button"
                disabled={screenShareStatus === 'requesting'}
                onClick={() => void startScreenShare()}
              >
                <MonitorIcon />
                {screenShareStatus === 'sharing'
                  ? 'Paylaşılan ekranı değiştir'
                  : 'Paylaşılacak ekranı seç'}
              </button>
            ) : null}
          </div>
        </section>
      ) : (
      <section className="workspace" aria-label="Bağlantı işlemleri">
        <section className="workspace-panel host-panel">
          <div className="panel-heading">
            <MonitorIcon />
            <div>
              <h1>Bu cihaz için destek al</h1>
              <p className="panel-subtitle">Kodu destek verecek kişiye söyleyin.</p>
            </div>
          </div>

          <div className="code-block">
            <span className="field-label">Bağlantı kodu</span>
            <div className="session-code" aria-live="polite">
              <strong>{formattedSessionCode}</strong>
              <button
                className="copy-button"
                type="button"
                onClick={copyCode}
                disabled={!signaling.sessionCode}
                aria-label="Bağlantı kodunu kopyala"
                title={copyStatus === 'copied' ? 'Kopyalandı' : 'Kodu kopyala'}
              >
                <CopyIcon />
              </button>
            </div>
            {copyStatus !== 'idle' ? (
              <small
                className={`copy-feedback copy-feedback--${copyStatus}`}
                role="status"
              >
                {copyStatus === 'copied'
                  ? 'Kod kopyalandı.'
                  : 'Kod kopyalanamadı; kodu elle paylaşın.'}
              </small>
            ) : null}
          </div>

          <button
            className="secondary-button"
            type="button"
            onClick={signaling.createSession}
            disabled={
              signaling.connectionStatus !== 'connected' ||
              signaling.sessionState === 'active'
            }
          >
            <RefreshIcon />
            Yeni kod oluştur
          </button>

          <div className="security-note">
            <LockIcon />
            <p>
              Bağlantılar şifrelenir. Görüntü mümkün olduğunda cihazlar arasında
              doğrudan aktarılır.
            </p>
          </div>
        </section>

        <section className="workspace-panel join-panel">
          <div className="panel-heading">
            <LinkIcon />
            <div>
              <h2>Başka bir cihaza destek ver</h2>
              <p className="panel-subtitle">Size söylenen 6 haneli kodu girin.</p>
            </div>
          </div>

          <form onSubmit={handleJoin} className="join-form">
            <label htmlFor="join-code">6 haneli bağlantı kodu</label>
            <input
              id="join-code"
              ref={joinInputRef}
              name="join-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              disabled={signaling.sessionState === 'active'}
              value={formatCode(joinCode)}
              onChange={(event) =>
                setJoinCode(event.target.value.replace(/\D/g, '').slice(0, 6))
              }
              placeholder="— — —   — — —"
              aria-describedby={
                signaling.errorCode && userFacingIssue
                  ? `issue-${userFacingIssue.id}`
                  : undefined
              }
            />
            <button
              className="primary-button"
              type="submit"
              disabled={
                joinCode.length !== 6 ||
                signaling.connectionStatus !== 'connected' ||
                signaling.sessionState === 'joining' ||
                signaling.sessionState === 'active'
              }
            >
              <ArrowRightIcon />
              {signaling.sessionState === 'joining' ? 'Onay bekleniyor' : 'Bağlan'}
            </button>
          </form>
        </section>
      </section>
      )}

      <footer className="activity-bar" aria-live="polite">
        <div className="activity-content">
          {signaling.sessionState === 'active' ? <NetworkIcon /> : <ClockIcon />}
          <span data-testid="connection-activity">
            {connectionActivity(
              signaling.activity,
              signaling.sessionState,
              signaling.sessionRole,
              peerConnection,
              nativeVideo,
              screenShareStatus,
              signaling.iceConfiguration,
            )}
          </span>
        </div>
        {signaling.sessionState === 'active' ||
        signaling.sessionState === 'recovering' ? (
          <div className="session-actions">
            {signaling.sessionState === 'active' &&
            signaling.sessionRole === 'host' ? (
              <div className="screen-share-control">
                <button
                  className={`screen-share-button${screenShareStatus === 'sharing' ? ' screen-share-button--active' : ''}`}
                  data-testid="screen-share-button"
                  type="button"
                  disabled={screenShareStatus === 'requesting'}
                  onClick={() => {
                    if (screenShareStatus === 'sharing') stopScreenShare()
                    else void startScreenShare()
                  }}
                >
                  <MonitorIcon />
                  {screenShareStatus === 'sharing'
                    ? 'Paylaşımı durdur'
                    : screenShareStatus === 'requesting'
                      ? 'Ekran seçiliyor'
                      : 'Ekranı paylaş'}
                </button>
              </div>
            ) : null}
            {signaling.sessionState === 'active' &&
            signaling.sessionRole === 'host' &&
            peerConnection.controlGranted ? (
              <button
                className="control-revoke-button"
                data-testid="control-revoke-button"
                type="button"
                onClick={revokeControl}
              >
                Kontrolü geri al
              </button>
            ) : null}
            <button
              className="session-end-button"
              type="button"
              onClick={signaling.leaveSession}
            >
              {signaling.sessionState === 'recovering'
                ? 'Kurtarmayı iptal et'
                : 'Bağlantıyı kes'}
            </button>
          </div>
        ) : null}
      </footer>

      {signaling.incomingRequest ? (
        <IncomingRequestDialog
          controlAvailable={desktop.isDesktop && desktop.controlInputAvailable}
          onApproveView={() => signaling.decideRequest(true, 'view')}
          onApproveControl={() => signaling.decideRequest(true, 'control')}
          onReject={() => signaling.decideRequest(false)}
        />
      ) : null}
    </main>
  )
}

function SessionOverview({
  role,
  peerConnection,
  nativeVideo,
  displays,
  selectedDisplayId,
  displaySwitching = false,
  onDisplaySelect,
  qualityProfile,
  qualitySwitching = false,
  onQualityProfileSelect,
  sessionDuration,
}: {
  role: 'host' | 'guest'
  peerConnection: ReturnType<typeof usePeerConnection>
  nativeVideo: ReturnType<typeof useNativeVideoPeer>
  displays: SessionDisplay[]
  selectedDisplayId: string | null
  displaySwitching?: boolean
  onDisplaySelect: (displayId: string) => boolean
  qualityProfile: QualityProfile
  qualitySwitching?: boolean
  onQualityProfileSelect: (profile: QualityProfile) => boolean
  sessionDuration: number
}) {
  const path = peerConnection.path === 'direct'
    ? { value: 'Doğrudan', detail: 'En hızlı yol' }
    : peerConnection.path === 'relay'
      ? { value: 'Aktarma sunucusu', detail: 'TURN relay' }
      : { value: 'Belirleniyor', detail: 'En iyi yol aranıyor' }
  const metrics = nativeVideo.metrics
  const bitrate = metrics
    ? `${(metrics.targetBitrate / 1_000_000).toFixed(1)} Mbps`
    : qualityProfile === 'speed'
      ? '3 Mbps’e kadar'
      : qualityProfile === 'quality'
        ? '12 Mbps’e kadar'
        : '8 Mbps’e kadar'
  const loss = metrics?.packetLossPercent === null || !metrics
    ? 'Ölçülüyor'
    : `%${metrics.packetLossPercent.toFixed(1)}`

  return (
    <div className="session-overview" data-testid="session-overview">
      <div className="session-role">
        <span className={`session-role__badge session-role__badge--${role}`}>
          {role === 'host' ? 'Destek alan cihaz' : 'Destek veren cihaz'}
        </span>
        <div>
          <strong>{role === 'host' ? 'Bu cihaz paylaşılıyor' : 'Uzak cihaza bağlısınız'}</strong>
          <span>{role === 'host' ? 'Bağlantı siz kesene kadar açık' : 'Güvenli destek oturumu etkin'}</span>
        </div>
      </div>

      <div className="session-controls">
        {displays.length > 0 ? (
          <label className="display-selector">
            <span>{role === 'host' ? 'Paylaşılan ekran' : 'Uzak ekran'}</span>
            <select
              value={selectedDisplayId ?? displays[0]?.id ?? ''}
              disabled={displaySwitching || peerConnection.status !== 'connected'}
              onChange={(event) => onDisplaySelect(event.target.value)}
              data-testid="display-selector"
            >
              {displays.map((display) => (
                <option key={display.id} value={display.id}>
                  {display.label} · {display.width}×{display.height}
                </option>
              ))}
            </select>
            {displaySwitching ? <small>Yeni ekrana geçiliyor…</small> : null}
          </label>
        ) : null}
        <label className="quality-selector">
          <span>Görüntü kalitesi</span>
          <select
            value={qualityProfile}
            disabled={qualitySwitching || peerConnection.status !== 'connected'}
            onChange={(event) =>
              onQualityProfileSelect(event.target.value as QualityProfile)
            }
            data-testid="quality-selector"
          >
            <option value="auto">Otomatik</option>
            <option value="speed">Hız öncelikli</option>
            <option value="quality">Kalite öncelikli</option>
          </select>
          {qualitySwitching ? <small>Profil uygulanıyor…</small> : null}
        </label>
      </div>

      <div className="connection-stats" aria-label="Bağlantı durumu">
        <StatusMetric label="Bağlantı yolu" value={path.value} detail={path.detail} />
        <StatusMetric
          label="Gecikme"
          value={peerConnection.latencyMs === null ? 'Ölçülüyor' : `${peerConnection.latencyMs} ms`}
          detail={peerConnection.latencyMs !== null && peerConnection.latencyMs < 120 ? 'İyi' : 'Canlı ölçüm'}
        />
        <StatusMetric
          label="Görüntü hızı"
          value={bitrate}
          detail={metrics ? 'Canlı hedef bitrate' : 'Profil tavanı'}
        />
        <StatusMetric label="Paket kaybı" value={loss} detail="Canlı ağ ölçümü" />
        <StatusMetric
          label="Bağlantı süresi"
          value={formatSessionDuration(sessionDuration)}
          detail="Onaylı oturum"
        />
      </div>
    </div>
  )
}

function StatusMetric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="status-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function RecoveryNotice({
  issue,
  onAction,
}: {
  issue: UserFacingIssue
  onAction: () => void
}) {
  return (
    <section
      className={`issue-notice issue-notice--${issue.tone}`}
      id={`issue-${issue.id}`}
      role={issue.tone === 'danger' ? 'alert' : 'status'}
      data-testid="recovery-notice"
    >
      <span className="issue-notice__icon" aria-hidden="true">
        <InfoIcon />
      </span>
      <div className="issue-notice__content">
        <strong>{issue.title}</strong>
        <span>{issue.message}</span>
      </div>
      {issue.action && issue.actionLabel ? (
        <button
          className="issue-notice__action"
          type="button"
          onClick={onAction}
        >
          <RefreshIcon />
          {issue.actionLabel}
        </button>
      ) : null}
    </section>
  )
}

function IncomingRequestDialog({
  controlAvailable,
  onApproveView,
  onApproveControl,
  onReject,
}: {
  controlAvailable: boolean
  onApproveView: () => void
  onApproveControl: () => void
  onReject: () => void
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="request-title"
        aria-describedby="request-description"
      >
        <button
          className="dialog-close"
          type="button"
          onClick={onReject}
          aria-label="Bağlantı isteğini reddet"
        >
          <XIcon />
        </button>
        <div className="dialog-icon" aria-hidden="true">
          <MonitorIcon />
        </div>
        <h2 id="request-title">Bağlantı isteği</h2>
        <p id="request-description">
          Bir cihaz ekranınızı görüntülemek için bağlantı kurmak istiyor. Kontrol
          iznini ayrı olarak seçebilirsiniz.
        </p>
        <div className="dialog-actions">
          <button className="dialog-reject" type="button" onClick={onReject}>
            Reddet
          </button>
          <button className="dialog-view" type="button" onClick={onApproveView}>
            Yalnızca görüntüle
          </button>
          <button
            className="dialog-approve"
            type="button"
            onClick={onApproveControl}
            disabled={!controlAvailable}
            title={
              controlAvailable
                ? undefined
                : 'Kontrol için Windows masaüstü uygulaması gereklidir.'
            }
          >
            {controlAvailable
              ? 'Görüntüle + kontrol et'
              : 'Kontrol için Windows uygulaması gerekli'}
          </button>
        </div>
      </section>
    </div>
  )
}

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="5" y="7" width="38" height="27" rx="5" />
      <path d="M18 41h12M24 34v7M13 21h17M25 15l6 6-6 6" />
    </svg>
  )
}

function resolveLocalMediaState(
  sessionState: 'idle' | 'waiting' | 'joining' | 'active' | 'recovering',
  sessionRole: 'host' | 'guest' | null,
  isDesktop: boolean,
  nativeStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed',
  screenShareStatus: 'idle' | 'requesting' | 'sharing',
  screenShareErrorCode: ScreenShareIssueCode | null,
): MediaState {
  if (sessionState !== 'active' || sessionRole !== 'host') return 'stopped'
  if (isDesktop) {
    if (nativeStatus === 'failed' || nativeStatus === 'disconnected') return 'failed'
    return nativeStatus === 'connected' ? 'sharing' : 'starting'
  }
  if (screenShareStatus === 'sharing') return 'sharing'
  if (screenShareStatus === 'requesting') return 'starting'
  return screenShareErrorCode === 'unsupported' ||
    screenShareErrorCode === 'start_failed'
    ? 'failed'
    : 'stopped'
}

function formatCode(code: string | null): string {
  if (!code) return '— — —   — — —'
  return code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

function connectionText(status: 'connecting' | 'connected' | 'disconnected'): string {
  if (status === 'connected') return 'Bağlantı hizmeti hazır'
  if (status === 'connecting') return 'Bağlantı hizmetine ulaşılıyor'
  return 'Bağlantı hizmetine ulaşılamıyor'
}

function connectionActivity(
  fallback: string,
  sessionState: 'idle' | 'waiting' | 'joining' | 'active' | 'recovering',
  sessionRole: 'host' | 'guest' | null,
  peerConnection: ReturnType<typeof usePeerConnection>,
  nativeVideo: ReturnType<typeof useNativeVideoPeer>,
  screenShareStatus: 'idle' | 'requesting' | 'sharing',
  iceConfiguration: IceConfiguration | null,
): string {
  if (sessionState !== 'active') return fallback
  if (peerConnection.status === 'failed') {
    return 'Güvenli cihaz bağlantısı kurulamadı.'
  }
  if (peerConnection.status === 'disconnected') {
    return 'Canlı cihaz bağlantısı kesildi.'
  }
  if (
    sessionRole === 'guest' &&
    peerConnection.remoteMediaState === 'failed' &&
    !peerConnection.remoteStream
  ) {
    return 'Destek alan cihaz ekran aktarımını yeniden başlatmalı.'
  }
  if (
    (nativeVideo.status === 'failed' || nativeVideo.status === 'disconnected') &&
    !peerConnection.remoteStream
  ) {
    return 'Ekran görüntüsü bağlantısı kurulamadı.'
  }
  if (peerConnection.status !== 'connected') {
    return hasTurnServer(iceConfiguration)
      ? 'Doğrudan bağlantı ve gerekirse TURN relay deneniyor.'
      : 'Doğrudan WebRTC veri kanalı kuruluyor.'
  }

  const pathLabel =
    peerConnection.path === 'direct'
      ? 'Doğrudan P2P bağlantısı'
      : peerConnection.path === 'relay'
        ? 'TURN relay bağlantısı'
        : 'WebRTC veri kanalı bağlı'
  const connectionLabel = peerConnection.latencyMs === null
    ? pathLabel
    : `${pathLabel} • ${peerConnection.latencyMs} ms gecikme`
  if (sessionRole === 'host' && screenShareStatus === 'sharing') {
    return `Ekran paylaşımı açık • ${connectionLabel}`
  }
  if (sessionRole === 'host' && nativeVideo.status === 'connected') {
    const qualityLabel = nativeQualityLabel(nativeVideo.metrics)
    return `GPU H.264 ekran aktarımı açık${qualityLabel ? ` • ${qualityLabel}` : ''} • ${connectionLabel}`
  }
  if (sessionRole === 'guest' && nativeVideo.remoteStream) {
    return `Native GPU ekranı alınıyor • ${connectionLabel}`
  }
  if (sessionRole === 'guest' && nativeVideo.active) {
    return `Native ekran aktarımı bekleniyor • ${connectionLabel}`
  }
  if (sessionRole === 'guest' && peerConnection.remoteStream) {
    return `Uzak ekran alınıyor • ${connectionLabel}`
  }
  if (sessionRole === 'guest') {
    return `Ekran paylaşımı bekleniyor • ${connectionLabel}`
  }
  return connectionLabel
}

function hasTurnServer(configuration: IceConfiguration | null): boolean {
  return (
    configuration?.iceServers.some((server) =>
      server.urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:')),
    ) ?? false
  )
}

function nativeQualityLabel(
  metrics: ReturnType<typeof useNativeVideoPeer>['metrics'],
): string | null {
  if (!metrics) return null
  const bitrate = `${(metrics.targetBitrate / 1_000_000).toFixed(1)} Mbps`
  if (metrics.packetLossPercent === null) return bitrate
  return `${bitrate} • %${metrics.packetLossPercent.toFixed(1)} paket kaybı`
}

export default App
