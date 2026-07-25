export const GLOBAL_REFRESH_EVENT = 'loven7-global-refresh';
export const GLOBAL_REFRESH_COMPLETE_EVENT = 'loven7-global-refresh-complete';

export type GlobalRefreshDetail = {
  menu?: string;
  source?: string;
  requestId?: number;
};

export function completeGlobalRefresh(requestId?: number) {
  if (typeof window === 'undefined' || !requestId) return;
  window.dispatchEvent(new CustomEvent(GLOBAL_REFRESH_COMPLETE_EVENT, { detail: { requestId } }));
}

export function waitForGlobalRefreshCompletion(requestId: number, timeoutMs = 15_000): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener(GLOBAL_REFRESH_COMPLETE_EVENT, onComplete);
      resolve();
    };
    const onComplete = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: number }>).detail;
      if (detail?.requestId === requestId) finish();
    };
    timer = window.setTimeout(finish, timeoutMs);
    window.addEventListener(GLOBAL_REFRESH_COMPLETE_EVENT, onComplete);
  });
}
