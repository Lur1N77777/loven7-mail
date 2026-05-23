/// <reference types="vite/client" />

interface Window {
  turnstile?: {
    render: (container: HTMLElement, options: Record<string, unknown>) => string;
    reset: (widgetId?: string) => void;
  };
}

declare const __APP_VERSION__: string;
