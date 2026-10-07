import { describe, expect, it } from 'vitest'
import {
  isSignalingIssueCode,
  resolveUserFacingIssue,
  signalingIssueMessage,
  type UserFacingIssueContext,
} from './userFacingIssue'

const BASE_CONTEXT: UserFacingIssueContext = {
  connectionStatus: 'connected',
  sessionState: 'idle',
  sessionRole: null,
  signalingErrorCode: null,
  peerStatus: 'idle',
  nativeVideoStatus: 'idle',
  fallbackScreenActive: false,
  remoteMediaState: 'stopped',
  desktopHasError: false,
  screenShareErrorCode: null,
  screenShareActive: false,
}

describe('user-facing recovery issues', () => {
  it('maps connection failures to a clear manual retry', () => {
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      connectionStatus: 'disconnected',
    })).toMatchObject({
      title: 'Bağlantı hizmetine ulaşılamıyor',
      action: 'retry-signaling',
      actionLabel: 'Şimdi yeniden bağlan',
    })
  })

  it('turns invalid and busy codes into a code-entry recovery path', () => {
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      signalingErrorCode: 'invalid_code',
    })?.action).toBe('edit-code')
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      signalingErrorCode: 'session_busy',
    })?.action).toBe('edit-code')
  })

  it('keeps session restart on the offer-producing host', () => {
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      sessionState: 'active',
      sessionRole: 'host',
      peerStatus: 'failed',
      nativeVideoStatus: 'failed',
    })).toMatchObject({
      id: 'session-connection-failed',
      action: 'retry-session',
    })

    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      sessionState: 'active',
      sessionRole: 'guest',
      peerStatus: 'failed',
    })?.action).toBeUndefined()
  })

  it('keeps protocol and server errors visible during recovery', () => {
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      connectionStatus: 'disconnected',
      sessionState: 'recovering',
      signalingErrorCode: 'peer_unavailable',
      peerStatus: 'failed',
    })).toMatchObject({
      id: 'peer-unavailable',
      action: 'retry-signaling',
    })

    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      connectionStatus: 'disconnected',
      sessionState: 'recovering',
    })).toBeNull()
  })

  it('requires a new approved session after negotiation capacity is exhausted', () => {
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      signalingErrorCode: 'negotiation_exhausted',
    })).toMatchObject({
      id: 'negotiation-exhausted',
      action: 'new-code',
    })
  })

  it('offers a specific video retry when the data connection remains open', () => {
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      sessionState: 'active',
      sessionRole: 'host',
      peerStatus: 'connected',
      nativeVideoStatus: 'failed',
    })).toMatchObject({
      title: 'Ekran aktarımı başlatılamadı',
      action: 'retry-video',
    })
  })

  it('keeps a working browser fallback visible as a degraded warning', () => {
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      sessionState: 'active',
      sessionRole: 'guest',
      peerStatus: 'connected',
      nativeVideoStatus: 'failed',
      fallbackScreenActive: true,
    })).toMatchObject({
      id: 'native-video-degraded',
      tone: 'warning',
      action: undefined,
    })
  })

  it('does not offer a guest-only native retry that cannot restart the host', () => {
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      sessionState: 'active',
      sessionRole: 'guest',
      peerStatus: 'connected',
      nativeVideoStatus: 'failed',
    })).toMatchObject({
      id: 'native-video-failed',
      action: undefined,
    })
  })

  it('shows the guest a safe host-side media failure and recovery instruction', () => {
    const issue = resolveUserFacingIssue({
      ...BASE_CONTEXT,
      sessionState: 'active',
      sessionRole: 'guest',
      peerStatus: 'connected',
      remoteMediaState: 'failed',
    })
    expect(issue).toMatchObject({
      id: 'remote-media-failed',
      title: 'Destek alan cihaz ekranı paylaşamıyor',
    })
    expect(issue?.action).toBeUndefined()
  })

  it('uses stable signaling codes and never accepts arbitrary server text', () => {
    expect(isSignalingIssueCode('invalid_code')).toBe(true)
    expect(isSignalingIssueCode('token=secret&candidate=private')).toBe(false)
    expect(isSignalingIssueCode('toString')).toBe(false)
    expect(signalingIssueMessage('invalid_server_response')).not.toContain('secret')
  })

  it('keeps unsupported screen sharing visible without a misleading retry', () => {
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      sessionState: 'active',
      sessionRole: 'host',
      peerStatus: 'connected',
      screenShareErrorCode: 'unsupported',
    })).toMatchObject({
      id: 'screen-share-unsupported',
      action: undefined,
    })
  })

  it('makes an existing share explicit when replacement selection fails', () => {
    expect(resolveUserFacingIssue({
      ...BASE_CONTEXT,
      sessionState: 'active',
      sessionRole: 'host',
      peerStatus: 'connected',
      screenShareErrorCode: 'selection_cancelled',
      screenShareActive: true,
    })).toMatchObject({
      title: 'Ekran seçimi iptal edildi',
      message: 'Önceki ekran paylaşılmaya devam ediyor. İsterseniz farklı ekranı yeniden seçin.',
    })
  })
})
