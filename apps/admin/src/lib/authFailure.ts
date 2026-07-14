export type AuthenticationFailure = {
  status?: unknown;
};

type AuthenticationFailureListener = (error: AuthenticationFailure) => void;

const listeners = new Set<AuthenticationFailureListener>();

export function isAuthenticationFailureStatus(error: unknown): error is AuthenticationFailure {
  if (!error || typeof error !== 'object') return false;
  const status = Number((error as AuthenticationFailure).status);
  return status === 401 || status === 403;
}

export function reportAuthenticationFailure(error: unknown): boolean {
  if (!isAuthenticationFailureStatus(error)) return false;
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
