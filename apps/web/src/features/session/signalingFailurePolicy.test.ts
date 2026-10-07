import { describe, expect, it } from 'vitest'
import {
  getServerErrorDisposition,
  getServerErrorMessageDisposition,
  getServerMessageDisposition,
} from './useSignaling'

describe('signaling failure policy', () => {
  it('limits code-entry errors to the pending join attempt', () => {
    expect(getServerErrorDisposition('invalid_code')).toBe('join-retry')
    expect(getServerErrorDisposition('session_busy')).toBe('join-retry')
    expect(
      getServerErrorDisposition('rate_limited', 'join_session'),
    ).toBe('join-retry')
  })

  it('keeps operation-specific throttling inside its originating session phase', () => {
    expect(
      getServerErrorDisposition('rate_limited', 'create_session'),
    ).toBe('create-retry')
    expect(
      getServerErrorDisposition('rate_limited', 'resume_session'),
    ).toBe('resume-retry')
    expect(
      getServerErrorDisposition('rate_limited', 'refresh_ice'),
    ).toBe('active-retry')
    expect(getServerErrorDisposition('rate_limited', 'signal')).toBe(
      'active-retry',
    )
    expect(getServerErrorDisposition('capacity_exceeded', 'create_session')).toBe(
      'create-retry',
    )
    expect(getServerErrorDisposition('rate_limited')).toBe('fail-closed')
    expect(getServerErrorDisposition('capacity_exceeded')).toBe('fail-closed')
  })

  it('stops approved media while preserving a resumable peer outage', () => {
    expect(getServerErrorDisposition('peer_unavailable')).toBe('resume-retry')
  })

  it('fails closed for authorization, protocol, and expired-resume errors', () => {
    expect(getServerErrorDisposition('not_authorized')).toBe('fail-closed')
    expect(getServerErrorDisposition('invalid_message')).toBe('fail-closed')
    expect(getServerErrorDisposition('invalid_resume')).toBe('fail-closed')
    expect(getServerErrorDisposition('negotiation_exhausted')).toBe('fail-closed')
  })

  it('allows session activation only from the matching role and phase', () => {
    expect(getServerMessageDisposition('session_approved', 'joining', 'guest')).toBe(
      'allow',
    )
    expect(getServerMessageDisposition('peer_joined', 'waiting', 'host')).toBe(
      'allow',
    )
    expect(getServerMessageDisposition('session_resumed', 'recovering', 'host')).toBe(
      'allow',
    )
    expect(getServerMessageDisposition('signal', 'active', 'guest')).toBe('allow')
  })

  it('ignores valid but late session messages after a terminal transition', () => {
    expect(getServerMessageDisposition('session_approved', 'idle', 'host')).toBe(
      'ignore',
    )
    expect(getServerMessageDisposition('peer_joined', 'idle', 'host')).toBe('ignore')
    expect(getServerMessageDisposition('peer_resumed', 'idle', 'host')).toBe('ignore')
    expect(getServerMessageDisposition('signal', 'idle', 'host')).toBe('ignore')
  })

  it('ignores uncorrelated session creation replies after the initiating phase', () => {
    expect(getServerMessageDisposition('session_created', 'active', 'host')).toBe(
      'ignore',
    )
    expect(getServerMessageDisposition('join_pending', 'idle', 'guest')).toBe(
      'ignore',
    )
    expect(getServerMessageDisposition('session_created', 'joining', 'guest')).toBe(
      'ignore',
    )
    expect(getServerMessageDisposition('join_pending', 'waiting', 'host')).toBe(
      'ignore',
    )
  })

  it('ignores stale retryable errors outside their originating phase', () => {
    expect(getServerErrorMessageDisposition('invalid_code', 'active', 'host')).toBe(
      'ignore',
    )
    expect(getServerErrorMessageDisposition('peer_unavailable', 'idle', 'host')).toBe(
      'ignore',
    )
    expect(
      getServerErrorMessageDisposition('invalid_code', 'joining', 'guest'),
    ).toBe('allow')
    expect(
      getServerErrorMessageDisposition('peer_unavailable', 'recovering', 'guest'),
    ).toBe('allow')
    expect(
      getServerErrorMessageDisposition(
        'rate_limited',
        'idle',
        'host',
        'create_session',
      ),
    ).toBe('allow')
    expect(
      getServerErrorMessageDisposition(
        'rate_limited',
        'active',
        'host',
        'signal',
      ),
    ).toBe('allow')
    expect(
      getServerErrorMessageDisposition(
        'rate_limited',
        'joining',
        'guest',
        'signal',
      ),
    ).toBe('ignore')
  })
})
