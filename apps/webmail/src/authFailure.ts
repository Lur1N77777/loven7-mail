export type AuthenticationFailure = {
  status: number;
  code?: unknown;
  message?: unknown;
};

type AuthenticationFailureListener = (error: AuthenticationFailure) => void;

const listeners = new Set<AuthenticationFailureListener>();

// 403 is overloaded: the API also uses it for "this share link forbids that
// action" and for capabilities the operator disabled, neither of which says
// anything about the mailbox credential. Only codes that describe the
// credential itself may end a session.
const CREDENTIAL_403_CODES = /\b(?:invalid_login|invalid_jwt|expired_jwt|address_mismatch|unauthorized|missing_jwt)\b/i;

export function isAuthenticationFailureStatus(error: unknown): error is AuthenticationFailure {
  if (!error || typeof error !== "object") return false;
  const failure = error as AuthenticationFailure;
  const status = Number(failure.status);
  if (status === 401) return true;
  if (status !== 403) return false;
  const detail = `${String(failure.code || "")}\n${String(failure.message || "")}`;
  return CREDENTIAL_403_CODES.test(detail);
}

// A single rejection is not proof that the session died: a sleeping phone, a
// network handover, or the 10s poll racing an upstream blip all produce one.
// A dead credential fails *every* request, so requiring a second strike costs
// an expired session nothing while making a transient failure survivable.
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
  const failure = error as AuthenticationFailure;
  for (const listener of listeners) {
    try {
      listener(failure);
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
