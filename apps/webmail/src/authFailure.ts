export type AuthenticationFailure = {
  status: number;
};

type AuthenticationFailureListener = (error: AuthenticationFailure) => void;

const listeners = new Set<AuthenticationFailureListener>();

export function reportAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = Number((error as { status?: unknown }).status);
  if (status !== 401 && status !== 403) return false;
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
