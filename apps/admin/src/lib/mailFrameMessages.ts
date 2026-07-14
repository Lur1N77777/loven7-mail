export type TrustedMailFrameMessage =
  | { type: 'loven7-mail-iframe-swipe'; direction: 'left' | 'right' }
  | { type: 'loven7-mail-iframe-swipe-progress'; dx: number };

export function readTrustedMailFrameMessage(
  event: { source: unknown; data: unknown },
  expectedSource: unknown,
): TrustedMailFrameMessage | null {
  if (!expectedSource || event.source !== expectedSource || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return null;
  const data = event.data as Record<string, unknown>;
  if (data.type === 'loven7-mail-iframe-swipe') {
    if (data.direction !== 'left' && data.direction !== 'right') return null;
    return { type: data.type, direction: data.direction };
  }
  if (data.type === 'loven7-mail-iframe-swipe-progress') {
    const dx = Number(data.dx);
    if (!Number.isFinite(dx) || Math.abs(dx) > 180) return null;
    return { type: data.type, dx };
  }
  return null;
}
