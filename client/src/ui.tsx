import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { STATUS_LABELS } from './format';

/* ---------- data loading ---------- */
export function useLoad<T = any>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!url) return;
    const s = ++seq.current;
    setLoading(true);
    try {
      const d = await api.get<T>(url);
      if (s === seq.current) { setData(d); setError(null); }
    } catch (e: any) {
      if (s === seq.current) setError(e.message);
    } finally {
      if (s === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

/* ---------- toasts ---------- */
type Toast = { id: number; kind: 'ok' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Run an async action with busy state and toast feedback. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (okText) toast('ok', okText);
      return r;
    } catch (e: any) {
      toast('error', e instanceof ApiError ? e.message : `Error: ${e.message}`);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { run, busy };
}

/* ---------- confirm dialog ---------- */
type ConfirmOpts = { title: string; body?: React.ReactNode; confirmText?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => close(false)} width={460}
          footer={<><Button onClick={() => close(false)}>Cancel</Button><Button kind={state.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>{state.confirmText ?? 'Confirm'}</Button></>}>
          {state.body}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

/* ---------- primitives ---------- */
export function Button({ kind = 'default', size, className = '', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'default' | 'primary' | 'danger' | 'ghost' | 'link'; size?: 'sm' }) {
  return <button type="button" className={`btn btn-${kind} ${size ? 'btn-sm' : ''} ${className}`} {...p} />;
}

export function Modal({ title, children, footer, onClose, width = 640 }: { title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; onClose: () => void; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close">×</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children, wide }: { label: React.ReactNode; hint?: React.ReactNode; error?: string | null; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`field ${wide ? 'field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: React.ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'info' | 'accent'; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = ({ approved: 'ok', released: 'ok', ok: 'ok', draft: 'neutral', proposed: 'info', planned: 'neutral', in_production: 'info', on_hold: 'warn', needs_review: 'warn', rejected: 'error', cancelled: 'neutral', archived: 'neutral', superseded: 'neutral' } as any)[status] ?? 'neutral';
  return <Badge tone={tone}>{STATUS_LABELS[status] ?? status}</Badge>;
}

export function Card({ title, actions, children, className = '', pad = true }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && <div className="card-head"><h2>{title}</h2><div className="card-actions">{actions}</div></div>}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{subtitle && <p className="subtitle">{subtitle}</p>}</div>
      <div className="page-actions">{actions}</div>
    </div>
  );
}

export function Loading({ error }: { error?: string | null }) {
  if (error) return <div className="alert alert-error">{error}</div>;
  return <div className="loading">Loading…</div>;
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: React.ReactNode }) {
  return <div className={`alert alert-${tone}`}>{children}</div>;
}

export function Warnings({ items }: { items: { level: string; message: string; code?: string }[] }) {
  if (!items?.length) return null;
  const order = { error: 0, warning: 1, info: 2 } as any;
  const sorted = [...items].sort((a, b) => order[a.level] - order[b.level]);
  const seen = new Set<string>();
  return (
    <ul className="warnings">
      {sorted.filter((w) => !seen.has(w.message) && seen.add(w.message)).map((w, i) => (
        <li key={i} className={`w-${w.level}`}><span className="w-dot" />{w.message}</li>
      ))}
    </ul>
  );
}

export function SaveState({ dirty, saving, savedAt }: { dirty: boolean; saving: boolean; savedAt?: string | null }) {
  if (saving) return <span className="save-state">Saving…</span>;
  if (dirty) return <span className="save-state save-dirty">Unsaved changes</span>;
  return <span className="save-state save-ok">{savedAt ? `Saved ${savedAt}` : 'All changes saved'}</span>;
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: React.ReactNode }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'tab-active' : ''}`} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

/** Text input that accepts decimal numbers (comma or dot) and shows invalid state. */
export function NumInput({ value, onChange, placeholder, className = '', invalid, ...rest }: { value: string | null | undefined; onChange: (v: string) => void; placeholder?: string; className?: string; invalid?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const v = value ?? '';
  const bad = invalid || (v !== '' && !/^[-+]?\d*[.,]?\d+$/.test(v.trim()));
  return <input inputMode="decimal" className={`input num ${bad ? 'input-invalid' : ''} ${className}`} value={v} placeholder={placeholder} onChange={(e) => onChange(e.target.value.replace(',', '.'))} {...rest} />;
}

export function SearchInput({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input type="search" className="input search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}
