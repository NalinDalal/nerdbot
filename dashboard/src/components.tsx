import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "./api";

const DOT_BY_STATUS: Record<string, string> = {
  done: "ok",
  succeeded: "ok",
  passed: "ok",
  delivered: "ok",
  approved: "ok",
  active: "ok",
  ready: "ok",
  failed: "bad",
  denied: "bad",
  rejected: "bad",
  blocked: "warn",
  running: "info",
  queued: "info",
  pending: "warn",
  sending: "info",
  needs_work: "warn",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="badge">
      <span className={`dot ${DOT_BY_STATUS[status] ?? ""}`} />
      {status}
    </span>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div style={{ fontWeight: 600, color: "var(--text)" }}>{title}</div>
      {hint ? <div style={{ marginTop: 4 }}>{hint}</div> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

export function LoadingState({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError ? `Error ${error.status}: ${error.detail}` : String(error);
  return (
    <div className="error-box" role="alert">
      <div>{message}</div>
      {onRetry ? (
        <div style={{ marginTop: 8 }}>
          <button onClick={onRetry}>Retry</button>
        </div>
      ) : null}
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <strong>{title}</strong>
          <button onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <div className="field-error">{error}</div> : null}
    </label>
  );
}

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  // `key` intentionally stands in for `fn`: callers pass the values that
  // identify the request, so the effect below stays free of render-scope reads.
  const key = JSON.stringify([nonce, ...deps]);
  useEffect(() => {
    let cancelled = false;
    fn().then(
      (result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
          setLoading(false);
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setError(err);
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    data,
    error,
    loading,
    reload: () => {
      setLoading(true);
      setNonce((n) => n + 1);
    },
  };
}

export function ShortId({ id }: { id: string }) {
  return <span className="mono" title={id}>{id.length > 18 ? `${id.slice(0, 18)}…` : id}</span>;
}
