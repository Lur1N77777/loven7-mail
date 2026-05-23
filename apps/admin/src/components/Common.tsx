import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Bell, Check, ChevronDown, Inbox, Loader2, X } from 'lucide-react';
import { PAGE_SIZE_OPTIONS, TOAST_MS } from '../lib/constants';
import { cls } from '../lib/format';

export type Notice = { type: 'success' | 'error' | 'info'; message: string } | null;
export type Notify = (type: NonNullable<Notice>['type'], message: string) => void;

export function useNotice() {
  const [notice, setNotice] = useState<Notice>(null);
  const timerRef = useRef<number | null>(null);
  const push = useCallback<Notify>((type, message) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setNotice({ type, message });
    timerRef.current = window.setTimeout(() => setNotice(null), TOAST_MS);
  }, []);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  return { notice, push };
}

export function Modal({ title, children, onClose, wide = false }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const content = (
    <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-hidden bg-slate-950/40 p-2.5 backdrop-blur-sm sm:p-5" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        className={cls('modal-card flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-[1.25rem] border border-white/80 bg-white shadow-2xl shadow-slate-950/20 sm:max-h-[calc(100dvh-2.5rem)] sm:rounded-[1.5rem]', wide ? 'max-w-5xl' : 'max-w-lg')}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3 sm:px-5 sm:py-3.5">
          <h3 className="min-w-0 truncate text-base font-semibold text-slate-800 sm:text-lg">{title}</h3>
          <button onClick={onClose} aria-label="关闭" className="ml-3 shrink-0 rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[calc(100dvh-5rem)] overflow-y-auto overflow-x-hidden p-4 sm:max-h-[calc(100dvh-7rem)] sm:p-5">{children}</div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

type ConfirmState = {
  title: string;
  body?: string;
  actionLabel?: string;
  onConfirm: () => Promise<void> | void;
};

export function useConfirm() {
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = useCallback((state: ConfirmState) => setConfirmState(state), []);
  const close = useCallback(() => { setConfirmState(null); setBusy(false); }, []);
  const handleConfirm = useCallback(async () => {
    if (!confirmState || busy) return;
    setBusy(true);
    try {
      await confirmState.onConfirm();
      setConfirmState(null);
    } catch (error) {
      console.error('confirm action failed', error);
    } finally {
      setBusy(false);
    }
  }, [busy, confirmState]);
  const modal = confirmState ? (
    <Modal title={confirmState.title} onClose={close}>
      <p className="text-sm leading-6 text-slate-500">{confirmState.body || '该操作不可撤销，请确认。'}</p>
      <div className="mt-6 flex justify-end gap-3">
        <button className="btn-secondary" disabled={busy} onClick={close}>取消</button>
        <button className="btn-danger" disabled={busy} onClick={handleConfirm}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {confirmState.actionLabel || '确认'}
        </button>
      </div>
    </Modal>
  ) : null;
  return { ask, modal };
}

export function NoticeToast({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <div className={cls(
      'fixed right-5 top-5 z-[80] flex max-w-md items-center gap-3 rounded-2xl border px-4 py-3 text-sm shadow-xl backdrop-blur-md',
      notice.type === 'success' && 'border-slate-200 bg-white/95 text-slate-800',
      notice.type === 'error' && 'border-rose-200 bg-rose-50/95 text-rose-800',
      notice.type === 'info' && 'border-slate-200 bg-white/95 text-slate-800',
    )}>
      {notice.type === 'success' ? <Check size={18} /> : notice.type === 'error' ? <AlertCircle size={18} /> : <Bell size={18} />}
      <span>{notice.message}</span>
    </div>
  );
}

export function LoadingState({ label = '加载中...' }: { label?: string }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-3 text-slate-400 md:min-h-48">
      <Loader2 className="h-6 w-6 animate-spin text-slate-600" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, body }: { icon?: React.ComponentType<{ size?: number | string; className?: string }>; title: string; body?: string }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center md:min-h-48 md:p-8">
      <div className="mb-4 rounded-2xl bg-white p-4 text-slate-600 shadow-sm"><Icon size={32} /></div>
      <h3 className="font-semibold text-slate-700">{title}</h3>
      {body && <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">{body}</p>}
    </div>
  );
}

export type PopoverSelectOption = {
  value: string;
  label: string;
  description?: string;
  count?: string | number;
  danger?: boolean;
  disabled?: boolean;
};

export function PopoverSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  disabled = false,
}: {
  value: string;
  options: PopoverSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const active = options.find((item) => item.value === value) || options[0];
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);
  useEffect(() => setOpen(false), [value]);
  return (
    <div ref={rootRef} className={cls('popover-select', className)}>
      <button
        type="button"
        className={cls('popover-select-trigger', open && 'is-open')}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="popover-select-copy">
          <span className="popover-select-label">{active?.label || '请选择'}</span>
          {active?.description && <span className="popover-select-description">{active.description}</span>}
        </span>
        <ChevronDown size={15} className="popover-select-chevron" />
      </button>
      {open && (
        <div className="popover-select-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={cls('popover-select-option', option.value === value && 'active', option.danger && 'danger')}
              disabled={option.disabled}
              onClick={() => {
                if (option.disabled) return;
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="popover-select-option-main">
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
              {option.count !== undefined && <span className="popover-select-option-count">{option.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Pagination({ page, setPage, pageSize, setPageSize, totalPages, count, variant = 'inline' }: { page: number; setPage: (page: number) => void; pageSize: number; setPageSize: (size: number) => void; totalPages: number; count: number; variant?: 'inline' | 'floating' }) {
  const [sizeOpen, setSizeOpen] = useState(false);
  useEffect(() => setSizeOpen(false), [pageSize]);
  return (
    <div className={cls('pagination-bar flex flex-row items-center justify-between gap-2 border-t border-slate-100 px-2 py-1.5 text-xs text-slate-500 md:px-3 md:py-2', variant === 'floating' && 'pagination-floating')}>
      <span className="pagination-summary min-w-0 truncate"><span className="hidden sm:inline">{count || 0} 条 · </span>{page}/{totalPages}</span>
      <div className="flex shrink-0 items-center gap-1">
        <div className="pagination-size-popover">
          <button
            type="button"
            aria-label="每页数量"
            aria-haspopup="menu"
            aria-expanded={sizeOpen}
            className={cls('form-select pagination-size pagination-size-trigger', sizeOpen && 'active')}
            onClick={() => setSizeOpen((open) => !open)}
          >
            {pageSize}/页
          </button>
          {sizeOpen && (
            <div className="pagination-size-menu" role="menu">
              {PAGE_SIZE_OPTIONS.map((size) => (
                <button
                  key={size}
                  type="button"
                  role="menuitemradio"
                  aria-checked={pageSize === size}
                  className={cls(pageSize === size && 'active')}
                  onClick={() => { setPageSize(size); setPage(1); setSizeOpen(false); }}
                >
                  {size}/页
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="page-btn compact" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="上一页">‹</button>
        <button className="page-btn compact" disabled={page >= totalPages} onClick={() => setPage(page + 1)} aria-label="下一页">›</button>
      </div>
    </div>
  );
}
