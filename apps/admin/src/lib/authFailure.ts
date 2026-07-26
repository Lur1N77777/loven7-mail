export type AuthenticationFailure = {
  status?: unknown;
  body?: unknown;
  message?: unknown;
  name?: unknown;
};

type AuthenticationFailureListener = (error: AuthenticationFailure) => void;

const listeners = new Set<AuthenticationFailureListener>();

export function isAuthenticationFailureStatus(error: unknown): error is AuthenticationFailure {
  if (!error || typeof error !== 'object') return false;
  const failure = error as AuthenticationFailure;
  const status = Number(failure.status);
  if (status === 401) return true;
  if (status !== 403) return false;

  // User endpoints reserve 403 for account authorization. Admin endpoints also
  // use 403 for disabled capabilities, so only explicit proxy auth codes count.
  if (failure.name === 'UserApiError') return true;
  const detail = `${String(failure.body || '')}\n${String(failure.message || '')}`;
  return /\b(?:invalid_admin_password|not_admin)\b/i.test(detail)
    || /管理员凭据无效|不是管理员|登录已失效/i.test(detail);
}

// A single rejection is not proof that the session died: a sleeping laptop, a
// network handover or a request that raced a token rotation all produce one.
// A dead credential fails *every* request, so waiting for a second strike
// costs an expired session nothing while making a blip survivable.
const CONFIRMATION_STRIKES = 2;
const STRIKE_WINDOW_MS = 5 * 60 * 1000;
let strikes = 0;
let firstStrikeAt = 0;

/** Any authenticated success proves the credential is alive; forget the strikes. */
export function noteAuthenticationSuccess(): void {
  strikes = 0;
  firstStrikeAt = 0;
}

export function reportAuthenticationFailure(error: unknown): boolean {
  if (!isAuthenticationFailureStatus(error)) return false;
  const now = Date.now();
  if (!strikes || now - firstStrikeAt > STRIKE_WINDOW_MS) {
    strikes = 0;
    firstStrikeAt = now;
  }
  strikes += 1;
  if (strikes < CONFIRMATION_STRIKES) return false;
  strikes = 0;
  firstStrikeAt = 0;
  for (const listener of listeners) {
    try {
      listener(error);
    } catch {
      // A UI cleanup failure must never replace the original HTTP error.
    }
  }
  return true;
}

export function subscribeAuthenticationFailures(listener: AuthenticationFailureListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
