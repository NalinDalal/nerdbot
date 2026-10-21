import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, describeError } from "./api";
import type { Permission } from "./types";

export function StatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  const variant =
    status === "done" || status === "active" || status === "ready"
      ? "ok"
      : status === "failed" || status === "denied" || status === "rejected"
        ? "bad"
        : status === "blocked" || status === "pending"
          ? "warn"
          : "info";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[var(--step-minus-1)] font-medium border border-transparent bg-[var(--surface-2)]`}>
      <span
        className={`w-1.5 h-1.5 rounded-full ${variant === "ok" ? "bg-[var(--accent)]" : variant === "bad" ? "bg-[var(--danger)]" : variant === "warn" ? "bg-[var(--warn)]" : "bg-[var(--info)]"}`}
      />
      {label ?? taskStatusLabel(status)}
    </span>
  );
}

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

export function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "Queued",
    running: "Running",
    failed: "Failed",
    blocked: "Blocked",
  };
  return labels[status] ?? status;
}

export function isTerminalTaskStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function isAwaitingApproval(status: string): boolean {
  return status === "blocked";
}

/* --- Theme --- */

export type Theme = "dark" | "light" | "system";

const THEME_KEY = "nerdbot.theme";

function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

export function useTheme() {
  const stored = (() => {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (v === "dark" || v === "light" || v === "system") return v;
    } catch {
      // ignore
    }
    return "system";
  })();
  const [theme, setTheme] = useState<Theme>(stored);
  const resolved = resolveTheme(theme);

  useEffect(() => {
    const root = document.documentElement;
    root.removeAttribute("data-theme");
    root.classList.remove("dark", "light");
    if (resolved === "dark") {
      root.classList.add("dark");
    } else {
      root.setAttribute("data-theme", "light");
      root.classList.add("light");
    }
  }, [resolved]);

  const setThemePref = (next: Theme) => {
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // ignore
    }
  };

  return { theme, resolved, setTheme: setThemePref };
}

export function ThemeButton({ onThemeChange }: { onThemeChange: (t: Theme) => void }) {
  const [index, setIndex] = useState(0);
  const cycle: Theme[] = ["dark", "light", "system"];
  const current = cycle[index];
  const label = current === "system" ? "System" : current === "dark" ? "Dark" : "Light";
  const icon = current === "system" ? "⭘" : current === "dark" ? "●" : "○";
  return (
    <button
      onClick={() => {
        const next = (index + 1) % cycle.length;
        setIndex(next);
        onThemeChange(cycle[next]);
      }}
      className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[var(--step-minus-1)] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1"
      aria-label={`Theme: ${label}`}
      title={label}
    >
      <span className="text-[var(--step-minus-1)]">{icon}</span>
      <span className="sr-only">{label}</span>
    </button>
  );
}

/* --- Page primitives --- */

/** Standard scroll container + header for a full-page view. Rebuilt views all
 *  use this shell so the product feels like one surface, not sewn parts. */
export function Page({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex-1 overflow-y-auto ${className}`}>
      <div className="mx-auto w-full max-w-[var(--max-width-wide)] px-6 py-6 md:px-8 md:py-8">
        {children}
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  back,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  back?: { label: string; onClick: () => void };
}) {
  return (
    <div className="mb-6">
      {back ? (
        <button
          onClick={back.onClick}
          className="mb-3 inline-flex items-center gap-1 text-[var(--step-minus-1)] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
        >
          <span aria-hidden>←</span> {back.label}
        </button>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="text-[var(--step-minus-2)] uppercase tracking-[0.16em] text-[var(--faint)] mb-1">
              {eyebrow}
            </div>
          ) : null}
          <h1 className="text-[var(--step-2)] font-semibold tracking-tight text-[var(--text)]">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-[72ch] text-[var(--step-0)] text-[var(--muted)] leading-relaxed">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
      </div>
    </div>
  );
}

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-[var(--step-minus-2)] font-medium uppercase tracking-[0.16em] text-[var(--faint)] ${className}`}>
      {children}
    </div>
  );
}

/* --- Status dot --- */

export function statusTone(status: string): "ok" | "bad" | "warn" | "info" | "neutral" {
  if (status === "running" || status === "active") return "info";
  if (status === "done" || status === "ready") return "ok";
  if (status === "failed" || status === "denied" || status === "rejected") return "bad";
  if (status === "blocked" || status === "pending" || status === "queued") return "warn";
  return "neutral";
}

export function StatusDot({
  status,
  label,
  pulse = false,
}: {
  status: string;
  label?: string;
  pulse?: boolean;
}) {
  const tone = statusTone(status);
  const color =
    tone === "ok" ? "bg-[var(--accent)]" : tone === "bad" ? "bg-[var(--danger)]" : tone === "warn" ? "bg-[var(--warn)]" : tone === "info" ? "bg-[var(--info)]" : "bg-[var(--faint)]";
  return (
    <span className="inline-flex items-center gap-1.5" title={label ?? status}>
      <span className={`h-[7px] w-[7px] rounded-full ${color} ${pulse ? "animate-pulse" : ""}`} />
      {label ? (
        <span className="text-[var(--step-minus-1)] text-[var(--text-soft)]">{label}</span>
      ) : null}
    </span>
  );
}

/** Compact identity chip for bots — avatar-ish initials + live status. */
export function BotChip({
  persona,
  id,
  status,
  size = "sm",
}: {
  persona: string;
  id: string;
  status: string;
  size?: "sm" | "md";
}) {
  const initials = persona
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const tone = statusTone(status);
  const dotColor =
    tone === "ok" ? "bg-[var(--accent)]" : tone === "bad" ? "bg-[var(--danger)]" : tone === "warn" ? "bg-[var(--warn)]" : tone === "info" ? "bg-[var(--info)]" : "bg-[var(--faint)]";
  const box = size === "md" ? "h-7 w-7 text-[10px]" : "h-6 w-6 text-[9px]";
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span className={`relative inline-flex shrink-0 items-center justify-center rounded-md bg-[var(--surface-3)] font-semibold text-[var(--text-soft)] ${box}`}>
        {initials || "?"}
        <span className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${dotColor} ring-2 ring-[var(--surface)]`} />
      </span>
      <span className="truncate text-[var(--step-minus-1)] text-[var(--text-soft)]" title={id}>
        {persona || "Unnamed"}
      </span>
    </span>
  );
}

/** Human "3m ago" style timestamp; falls back to the raw string. */
export function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts) || !iso) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/* --- Empty / loading / error states --- */

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="text-[var(--step-1)] font-semibold text-[var(--text)]">{title}</div>
      {hint ? (
        <div className="mt-3 text-[var(--step-0)] text-[var(--muted)] leading-1.5 max-w-[42ch]">
          {hint}
        </div>
      ) : null}
      {action ? (
        <div className="mt-6">{action}</div>
      ) : null}
    </div>
  );
}

export function LoadingState({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-label="Loading" className="flex flex-col gap-1.5">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-3.5 w-full rounded-sm bg-[var(--surface-2)] animate-shimmer" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = describeError(error);
  return (
    <div className="rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-4 py-3 text-[var(--step-0)]">
      <div>{message}</div>
      {onRetry ? (
        <div className="mt-3">
          <button onClick={onRetry} className="text-[var(--step-minus-1)] text-[var(--accent)] hover:underline">
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* --- Modal --- */

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <strong className="text-[var(--step-1)] font-semibold">{title}</strong>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm p-1.5 text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition-colors"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* --- Field --- */

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
    <div className="mb-4">
      <span className="block text-[var(--step-minus-1)] font-medium text-[var(--muted)] mb-1.5 uppercase tracking-wide">
        {label}
      </span>
      {children}
      {error ? (
        <div className="mt-1.5 text-[var(--step-minus-1)] text-[var(--danger)]">{error}</div>
      ) : null}
    </div>
  );
}

/* --- Primitive buttons --- */

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
  className,
  title,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  className?: string;
  title?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-[var(--step-minus-1)] font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";
  const variants: Record<string, string> = {
    default:
      "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:border-[var(--faint)] hover:text-[var(--text)]",
    primary:
      "bg-[var(--accent)] border-[var(--accent)] text-[var(--text-inverse)] font-semibold hover:bg-[var(--accent-hover)] hover:border-[var(--accent-hover)]",
    danger:
      "border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger-dim)]",
    ghost:
      "border-transparent bg-transparent text-[var(--text-soft)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${variants[variant]} ${className || ""}`}
    >
      {children}
    </button>
  );
}

/* --- Input / select / textarea --- */

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
    <div className="mb-4">
      {label && (
        <span className="block text-[var(--step-minus-1)] font-medium text-[var(--muted)] mb-1.5 uppercase tracking-wide">
          {label}
        </span>
      )}
      <input
        id={id}
        type={type}
        value={value ?? ""}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        className={`rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] text-[var(--text)] transition-colors focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)] outline-none disabled:opacity-50 ${error ? "border-[var(--danger)]" : ""} w-full`}
      />
      {error && <div className="mt-1.5 text-[var(--step-minus-1)] text-[var(--danger)]">{error}</div>}
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
    <div className="mb-4">
      {label && (
        <span className="block text-[var(--step-minus-1)] font-medium text-[var(--muted)] mb-1.5 uppercase tracking-wide">
          {label}
        </span>
      )}
      <select
        id={id}
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] text-[var(--text)] transition-colors focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)] outline-none disabled:opacity-50 w-full"
      >
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
  const bg = variant === "ok" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : variant === "bad" ? "bg-[var(--danger-dim)] text-[var(--danger)]" : variant === "warn" ? "bg-[var(--warn-dim)] text-[var(--warn)]" : variant === "info" ? "bg-[var(--info-dim)] text-[var(--info)]" : "bg-[var(--surface-2)] text-[var(--muted)]";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-0.5 text-[var(--step-minus-1)] font-medium ${bg}`}>
      {variant === "neutral" ? null : <span className="w-1.5 h-1.5 rounded-full opacity-60" />}
      {children}
    </span>
  );
}

/* --- Card --- */

export function Card({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm ${className || ""}`}>
      {children}
    </div>
  );
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
      className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 w-full max-w-lg shadow-lg" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <strong className="text-[var(--step-1)] font-semibold modal-title">{title}</strong>
          <button className="modal-close rounded-sm p-1.5 text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition-colors" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ShortId({ id }: { id: string }) {
  return <span className="mono text-[var(--step-minus-1)]" title={id}>{id.length > 18 ? `${id.slice(0, 18)}…` : id}</span>;
}

/* --- Async --- */

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

/* --- Permission catalogue --- */

let cataloguePromise: Promise<Permission[]> | null = null;

function loadCatalogue(): Promise<Permission[]> {
  if (!cataloguePromise) {
    cataloguePromise = api
      .permissions()
      .then((res) => res.permissions)
      .catch((err) => {
        cataloguePromise = null;
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
