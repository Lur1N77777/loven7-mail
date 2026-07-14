function runtimeOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function adminMailStateEndpoint(suffix = '', origin = runtimeOrigin()): string {
  const path = `/api/mail-state${suffix}`;
  return origin ? new URL(path, origin).toString() : path;
}
