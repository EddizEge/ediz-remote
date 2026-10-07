import type { ServerMessage } from '@ediz-remote/protocol'

type ServerErrorCode = Extract<ServerMessage, { type: 'error' }>['code']

export type SignalingIssueCode =
  | ServerErrorCode
  | 'invalid_server_response'
  | 'invalid_ice_configuration'
  | 'request_rejected'
  | 'session_ended'

export type ScreenShareIssueCode =
  | 'unsupported'
  | 'selection_cancelled'
  | 'start_failed'
  | 'quality_failed'

export type RecoveryActionId =
  | 'retry-signaling'
  | 'edit-code'
  | 'new-code'
  | 'retry-session'
  | 'retry-video'
  | 'retry-desktop'
  | 'retry-screen-share'

export interface UserFacingIssue {
  id: string
  tone: 'warning' | 'danger'
  title: string
  message: string
  action?: RecoveryActionId
  actionLabel?: string
}

export interface UserFacingIssueContext {
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
  sessionState: 'idle' | 'waiting' | 'joining' | 'active' | 'recovering'
  sessionRole: 'host' | 'guest' | null
  signalingErrorCode: SignalingIssueCode | null
  peerStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed'
  nativeVideoStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed'
  fallbackScreenActive: boolean
  remoteMediaState: 'starting' | 'sharing' | 'failed' | 'stopped'
  desktopHasError: boolean
  screenShareErrorCode: ScreenShareIssueCode | null
  screenShareActive: boolean
}

const SIGNALING_ISSUES: Record<SignalingIssueCode, UserFacingIssue> = {
  invalid_code: {
    id: 'invalid-code',
    tone: 'warning',
    title: 'Kod geçersiz veya süresi dolmuş',
    message: 'Destek alan cihazdan güncel kodu isteyin ve yeniden girin.',
    action: 'edit-code',
    actionLabel: 'Başka kod gir',
  },
  session_busy: {
    id: 'session-busy',
    tone: 'warning',
    title: 'Bu kod şu anda kullanımda',
    message: 'Destek alan cihazdan yeni bir bağlantı kodu isteyin.',
    action: 'edit-code',
    actionLabel: 'Başka kod gir',
  },
  rate_limited: {
    id: 'rate-limited',
    tone: 'warning',
    title: 'İstekler geçici olarak sınırlandı',
    message: 'Bağlantı kurtarma otomatik devam eder; kod oluşturma veya katılma işlemini bekleme süresi sonunda yeniden deneyebilirsiniz.',
  },
  capacity_exceeded: {
    id: 'capacity-exceeded',
    tone: 'warning',
    title: 'Oturum kapasitesi geçici olarak dolu',
    message: 'Açık oturumlar kapandıktan sonra yeni bağlantı kodunu yeniden deneyin.',
  },
  request_rejected: {
    id: 'request-rejected',
    tone: 'warning',
    title: 'Bağlantı isteği kabul edilmedi',
    message: 'Destek alan kişi hazır olduğunda yeni kodla tekrar deneyebilirsiniz.',
    action: 'edit-code',
    actionLabel: 'Yeni kod gir',
  },
  invalid_resume: {
    id: 'resume-expired',
    tone: 'warning',
    title: 'Önceki bağlantı kurtarılamadı',
    message: 'Güvenliğiniz için eski onay kapatıldı. Yeni kodla tekrar bağlanın.',
    action: 'new-code',
    actionLabel: 'Yeni bağlantı hazırla',
  },
  session_ended: {
    id: 'session-ended',
    tone: 'warning',
    title: 'Bağlantı sona erdi',
    message: 'Eski onay artık kullanılamaz. Yeni bir bağlantı kodu oluşturabilirsiniz.',
    action: 'new-code',
    actionLabel: 'Yeni kod oluştur',
  },
  peer_unavailable: {
    id: 'peer-unavailable',
    tone: 'warning',
    title: 'Karşı cihaz yeniden bağlanıyor',
    message: 'Ekran ve kontrol güvenli biçimde durduruldu. Bağlantıyı şimdi yenileyebilirsiniz.',
    action: 'retry-signaling',
    actionLabel: 'Şimdi yeniden dene',
  },
  negotiation_exhausted: {
    id: 'negotiation-exhausted',
    tone: 'warning',
    title: 'Güvenli bağlantı yenileme sınırına ulaştı',
    message: 'Eski erişim kapatıldı. Devam etmek için yeni bir bağlantı kodu oluşturun.',
    action: 'new-code',
    actionLabel: 'Yeni kod oluştur',
  },
  invalid_ice_configuration: {
    id: 'invalid-connection-settings',
    tone: 'danger',
    title: 'Bağlantı ayarları alınamadı',
    message: 'Ekran ve kontrol başlatılmadı. Güvenli bağlantıyı yeniden kurmayı deneyin.',
    action: 'retry-signaling',
    actionLabel: 'Bağlantıyı yenile',
  },
  invalid_server_response: {
    id: 'invalid-server-response',
    tone: 'danger',
    title: 'Hizmetten beklenmeyen bir yanıt alındı',
    message: 'Herhangi bir erişim başlatılmadı. Hizmete yeniden bağlanmayı deneyin.',
    action: 'retry-signaling',
    actionLabel: 'Yeniden bağlan',
  },
  invalid_message: {
    id: 'invalid-request',
    tone: 'danger',
    title: 'İstek güvenli biçimde işlenemedi',
    message: 'Oturum başlatılmadı. Yeni bir bağlantı koduyla tekrar deneyin.',
    action: 'new-code',
    actionLabel: 'Yeni kod oluştur',
  },
  not_authorized: {
    id: 'approval-required',
    tone: 'danger',
    title: 'Bu işlem için geçerli onay yok',
    message: 'Ekran ve kontrol kapalı tutuldu. Yeni bağlantı koduyla tekrar başlayın.',
    action: 'new-code',
    actionLabel: 'Yeni kod oluştur',
  },
}

export function isSignalingIssueCode(value: unknown): value is SignalingIssueCode {
  return typeof value === 'string' && Object.hasOwn(SIGNALING_ISSUES, value)
}

export function signalingIssueMessage(code: SignalingIssueCode | null): string | null {
  return code ? SIGNALING_ISSUES[code].message : null
}

export function screenShareIssueMessage(
  code: ScreenShareIssueCode | null,
): string | null {
  if (!code) return null
  if (code === 'unsupported') {
    return 'Bu ortam ekran paylaşımını desteklemiyor.'
  }
  if (code === 'selection_cancelled') {
    return 'Ekran seçimi iptal edildi.'
  }
  if (code === 'quality_failed') {
    return 'Seçilen kalite bu ekran paylaşımına uygulanamadı.'
  }
  return 'Ekran paylaşımı başlatılamadı.'
}

export function resolveUserFacingIssue(
  context: UserFacingIssueContext,
): UserFacingIssue | null {
  if (context.signalingErrorCode) {
    return SIGNALING_ISSUES[context.signalingErrorCode]
  }

  if (context.sessionState === 'recovering') return null

  if (context.connectionStatus === 'disconnected') {
    return {
      id: 'service-disconnected',
      tone: 'danger',
      title: 'Bağlantı hizmetine ulaşılamıyor',
      message: 'Uygulama otomatik olarak tekrar deniyor. İnternet bağlantınızı kontrol edip şimdi de deneyebilirsiniz.',
      action: 'retry-signaling',
      actionLabel: 'Şimdi yeniden bağlan',
    }
  }

  if (context.sessionState === 'active') {
    if (context.peerStatus === 'failed' || context.peerStatus === 'disconnected') {
      const hostCanRestart = context.sessionRole === 'host'
      return {
        id: 'session-connection-failed',
        tone: 'danger',
        title:
          context.peerStatus === 'disconnected'
            ? 'Canlı bağlantı kesildi'
            : 'Güvenli bağlantı kurulamadı',
        message: hostCanRestart
          ? 'Ekran ve kontrol durduruldu. Aynı onaylı oturum içinde güvenli bağlantıyı yeniden kurabilirsiniz.'
          : 'Ekran ve kontrol durduruldu. Destek alan kişi bağlantıyı yeniden başlatmalı.',
        action: hostCanRestart ? 'retry-session' : undefined,
        actionLabel: hostCanRestart ? 'Bağlantıyı yenile' : undefined,
      }
    }

    if (
      context.sessionRole === 'guest' &&
      context.remoteMediaState === 'failed' &&
      !context.fallbackScreenActive
    ) {
      return {
        id: 'remote-media-failed',
        tone: 'danger',
        title: 'Destek alan cihaz ekranı paylaşamıyor',
        message: 'Karşı cihazdaki Ediz Remote ekran aktarımını durdurdu. Destek alan kişi görüntüyü yeniden denemeli.',
      }
    }

    if (
      context.nativeVideoStatus === 'failed' ||
      context.nativeVideoStatus === 'disconnected'
    ) {
      const hostCanRestart = context.sessionRole === 'host'
      if (context.fallbackScreenActive) {
        return {
          id: 'native-video-degraded',
          tone: 'warning',
          title: 'Tarayıcı görüntüsüyle devam ediliyor',
          message: hostCanRestart
            ? 'Hızlandırılmış görüntü yolu kurulamadı, ancak ekran paylaşımı açık. İsterseniz hızlandırılmış görüntüyü yeniden deneyin.'
            : 'Hızlandırılmış görüntü yolu kurulamadı, ancak tarayıcı ekran paylaşımıyla devam ediliyor.',
          action: hostCanRestart ? 'retry-video' : undefined,
          actionLabel: hostCanRestart
            ? 'Hızlandırılmış görüntüyü dene'
            : undefined,
        }
      }
      return {
        id: 'native-video-failed',
        tone: 'danger',
        title:
          context.sessionRole === 'guest'
            ? 'Uzak ekran görüntüsü alınamıyor'
            : 'Ekran aktarımı başlatılamadı',
        message: hostCanRestart
          ? 'Bağlantı açık, ancak görüntü aktarımı kurulamadı. Görüntüyü güvenli biçimde yeniden başlatın.'
          : 'Bağlantı açık, ancak görüntü aktarımı kurulamadı. Destek alan kişi görüntüyü yeniden başlatmalı.',
        action: hostCanRestart ? 'retry-video' : undefined,
        actionLabel: hostCanRestart ? 'Görüntüyü yeniden dene' : undefined,
      }
    }

    if (context.screenShareErrorCode) {
      const selectionCancelled =
        context.screenShareErrorCode === 'selection_cancelled'
      return {
        id: `screen-share-${context.screenShareErrorCode}`,
        tone: selectionCancelled ? 'warning' : 'danger',
        title: selectionCancelled
          ? 'Ekran seçimi iptal edildi'
          : context.screenShareActive
            ? 'Yeni ekran seçilemedi'
            : 'Ekran paylaşımı başlatılamadı',
        message:
          context.screenShareErrorCode === 'unsupported'
            ? 'Bu tarayıcı ekran paylaşımını desteklemiyor. Güncel bir Chromium tarayıcı veya Windows uygulamasını kullanın.'
            : context.screenShareErrorCode === 'quality_failed'
              ? 'Paylaşım açık kaldı, ancak seçilen kalite uygulanamadı. Ekranı yeniden seçmeyi deneyin.'
              : context.screenShareActive
                ? 'Önceki ekran paylaşılmaya devam ediyor. İsterseniz farklı ekranı yeniden seçin.'
                : 'Hazır olduğunuzda paylaşılacak ekranı yeniden seçebilirsiniz.',
        action:
          context.screenShareErrorCode === 'unsupported'
            ? undefined
            : 'retry-screen-share',
        actionLabel:
          context.screenShareErrorCode === 'unsupported'
            ? undefined
            : 'Ekranı yeniden seç',
      }
    }
  }

  if (context.desktopHasError) {
    return {
      id: 'desktop-components-unavailable',
      tone: 'warning',
      title: 'Windows özellikleri tam hazır değil',
      message: 'Görüntü veya kontrol bileşenlerinden biri hazırlanamadı. Durumu yeniden kontrol edebilirsiniz.',
      action: 'retry-desktop',
      actionLabel: 'Tekrar kontrol et',
    }
  }

  return null
}
