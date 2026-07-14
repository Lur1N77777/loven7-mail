import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError } from '../lib/appRecovery';

type BoundaryState = { error: Error | null; chunkFailure: boolean };

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : 'Unexpected application error');
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  declare readonly props: { children: ReactNode };
  declare setState: (state: BoundaryState | ((previous: BoundaryState) => BoundaryState)) => void;
  state: BoundaryState = { error: null, chunkFailure: false };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error, chunkFailure: isChunkLoadError(error) };
  }

  componentDidMount() {
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
    window.addEventListener('vite:preloadError', this.handlePreloadError as EventListener);
  }

  componentWillUnmount() {
    window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
    window.removeEventListener('vite:preloadError', this.handlePreloadError as EventListener);
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Admin UI recovered from a render error', error.name, info.componentStack);
  }

  private handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (!isChunkLoadError(event.reason)) return;
    event.preventDefault();
    this.setState({ error: normalizeError(event.reason), chunkFailure: true });
  };

  private handlePreloadError = (event: Event & { payload?: unknown }) => {
    event.preventDefault();
    this.setState({ error: normalizeError(event.payload || 'Application update failed to load'), chunkFailure: true });
  };

  private reload = () => window.location.reload();

  render() {
    if (!this.state.error) return this.props.children;
    const english = document.documentElement.dataset.locale === 'en-US';
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-slate-50 p-5 text-slate-800">
        <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm" role="alert">
          <h1 className="text-xl font-semibold">{this.state.chunkFailure ? (english ? 'Update ready' : '检测到新版本') : (english ? 'Something went wrong' : '页面暂时无法显示')}</h1>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            {this.state.chunkFailure
              ? (english ? 'Refresh once to load the latest application files.' : '刷新一次即可加载最新的应用文件。')
              : (english ? 'Your session is still kept. Retry this view or refresh the page.' : '登录状态仍会保留，请重试当前页面或刷新。')}
          </p>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            {!this.state.chunkFailure ? <button type="button" className="btn-secondary justify-center" onClick={() => this.setState({ error: null, chunkFailure: false })}>{english ? 'Retry' : '重试'}</button> : null}
            <button type="button" className="btn-primary justify-center" onClick={this.reload}>{english ? 'Refresh' : '刷新页面'}</button>
          </div>
        </section>
      </main>
    );
  }
}
