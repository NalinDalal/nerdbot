import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, describeError } from "./api";
import type { Permission } from "./types";

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

export function StatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  return (
    <span className="badge">
      <span className={`dot ${DOT_BY_STATUS[status] ?? ""}`} />
      {label ?? taskStatusLabel(status)}
    </span>
  );
}

/** Human-readable label for task statuses, per the backend TaskStatus enum. */
export function taskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "Queued",
    ready: "Ready",
    running: "Running",
    done: "Completed",
    failed: "Failed",
    blocked: "Awaiting approval",
    cancelled: "Cancelled",
  };
  return labels[status] ?? status;
}

/** Human-readable label for run statuses, per the backend RunStatus enum. */
export function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "Queued",
    running: "Running",
    failed: "Failed",
    blocked: "Blocked",
  };
  return labels[status] ?? status;
}

/** Whether a task is in a terminal state. */
export function isTerminalTaskStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** Whether a task is awaiting a user decision (approval). */
export function isAwaitingApproval(status: string): boolean {
  return status === "blocked";
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
  const message = describeError(error);
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

/* --- Primitive buttons --- */
export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
  icon,
  className,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`button ${variant === "primary" ? "button.primary" : variant === "danger" ? "button.danger" : ""} ${className || ""}`}
    >
      {icon && <span style={{ marginRight: 6 }}>{icon}</span>}
      {children}
    </button>
  );
}

/* --- Input / select --- */
export function Input({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
  error,
  type = "text",
}: {
  id?: string;
  label?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  type?: string;
}) {
  return (
    <div className="field">
      {label && <span>{label}</span>}
      <input
        id={id}
        type={type}
        value={value ?? ""}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        className={error ? "error" : undefined}
      />
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

export function Select({
  id,
  label,
  value,
  onChange,
  children,
  disabled,
  placeholder,
}: {
  id?: string;
  label?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  children?: ReactNode;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="field">
      {label && <span>{label}</span>}
      <select id={id} value={value} onChange={onChange} disabled={disabled}>
        {placeholder && <option value="" disabled hidden>{placeholder}</option>}
        {children}
      </select>
    </div>
  );
}

/* --- Badge --- */
export function Badge({
  children,
  variant = "neutral",
}: {
  children?: ReactNode;
  variant?: "neutral" | "ok" | "bad" | "warn" | "info";
}) {
  const dotClass = `dot ${variant === "ok" ? "ok" : variant === "bad" ? "bad" : variant === "warn" ? "warn" : variant === "info" ? "info" : ""}`;
  return (
    <span className="badge pill">
      <span className={dotClass} />
      {children}
    </span>
  );
}

/* --- Card --- */
export function Card({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={`card ${className || ""}`}>{children}</div>;
}

/* --- Dialog (modal) --- */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <strong className="modal-title">{title}</strong>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ShortId({ id }: { id: string }) {
  return <span className="mono" title={id}>{id.length > 18 ? `${id.slice(0, 18)}…` : id}</span>;
}

/**
 * The backend's canonical permission catalogue.
 *
 * The UI never hard-codes permission names: it renders what the server
 * enforces, so a permission the backend knows can never be missing from the
 * editor, and the editor can never offer a name the backend would reject.
 * The result is cached for the session — the catalogue does not change at
 * runtime.
 */
let cataloguePromise: Promise<Permission[]> | null = null;

function loadCatalogue(): Promise<Permission[]> {
  if (!cataloguePromise) {
    cataloguePromise = api
      .permissions()
      .then((res) => res.permissions)
      .catch((err) => {
        cataloguePromise = null; // let the next mount retry
        throw err;
      });
  }
  return cataloguePromise;
}

export interface PermissionCatalogue {
  permissions: Permission[];
  loading: boolean;
  error: unknown;
  byName: Map<string, Permission>;
  isAdmin: (name: string) => boolean;
  /** Permissions the backend knows about but the bot does not hold. */
  denied: (held: string[]) => Permission[];
}

export function usePermissionCatalogue(): PermissionCatalogue {
  const state = useAsync(() => loadCatalogue(), []);
  const permissions = state.data ?? [];
  const byName = new Map(permissions.map((p) => [p.name, p]));
  return {
    permissions,
    loading: state.loading,
    error: state.error,
    byName,
    isAdmin: (name: string) => byName.get(name)?.kind === "admin",
    denied: (held: string[]) =>
      permissions.filter((p) => !held.includes(p.name)),
  };
}

