export async function copyText(value: string): Promise<void> {
  const text = String(value || '').trim();
  if (!text) throw new Error('Nothing to copy');

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some browsers reject Clipboard API writes even during a user gesture.
    }
  }

  if (typeof document === 'undefined' || !document.body) throw new Error('Copy is unavailable');
  const textarea = document.createElement('textarea');
  const previousFocus = document.activeElement as { focus?: (options?: FocusOptions) => void } | null;
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
    if (!copied) throw new Error('Copy failed');
  } finally {
    textarea.remove();
    previousFocus?.focus?.({ preventScroll: true });
  }
}
