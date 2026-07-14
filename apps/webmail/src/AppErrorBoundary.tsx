import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError } from "./appRecovery";

type BoundaryState = { error: Error | null; chunkFailure: boolean };

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "Unexpected application error");
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null, chunkFailure: false };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error, chunkFailure: isChunkLoadError(error) };
  }

  componentDidMount() {
    window.addEventListener("unhandledrejection", this.handleUnhandledRejection);
    window.addEventListener("vite:preloadError", this.handlePreloadError as EventListener);
  }

  componentWillUnmount() {
    window.removeEventListener("unhandledrejection", this.handleUnhandledRejection);
    window.removeEventListener("vite:preloadError", this.handlePreloadError as EventListener);
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Webmail UI recovered from a render error", error.name, info.componentStack);
  }

  private handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (!isChunkLoadError(event.reason)) return;
    event.preventDefault();
    this.setState({ error: normalizeError(event.reason), chunkFailure: true });
  };

  private handlePreloadError = (event: Event & { payload?: unknown }) => {
    event.preventDefault();
    this.setState({ error: normalizeError(event.payload || "Application update failed to load"), chunkFailure: true });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const english = document.documentElement.dataset.locale === "en-US";
    return (
      <main className="recovery-shell" role="alert">
        <section className="recovery-card">
          <h1>{this.state.chunkFailure ? (english ? "Update ready" : "检测到新版本") : (english ? "Something went wrong" : "页面暂时无法显示")}</h1>
          <p>{this.state.chunkFailure ? (english ? "Refresh once to load the latest files." : "刷新一次即可加载最新文件。") : (english ? "Your session is still kept. Retry or refresh." : "登录状态仍会保留，请重试或刷新。")}</p>
          <div>
            {!this.state.chunkFailure ? <button type="button" className="ghost-button" onClick={() => this.setState({ error: null, chunkFailure: false })}>{english ? "Retry" : "重试"}</button> : null}
            <button type="button" className="primary-button" onClick={() => window.location.reload()}>{english ? "Refresh" : "刷新页面"}</button>
          </div>
        </section>
      </main>
    );
  }
}
