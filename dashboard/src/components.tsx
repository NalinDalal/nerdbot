import { cloneElement, isValidElement, useEffect, useRef, useState, useId } from "react";
import type { ReactElement } from "react";
import type { ReactNode } from "react";
import { api, describeError } from "./api";
import type { Permission, Task } from "./types";

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
    stopped: "Stopped",
    cancelled: "Cancelled",
  };
  return labels[status] ?? status;
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
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Move focus to the first sensible control while open; restore it on close.
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const selector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const firstInput = panel?.querySelector<HTMLElement>("textarea, input, select");
    const first = firstInput ?? panel?.querySelector<HTMLElement>(selector);
    first?.focus();
    return () => {
      previous?.focus();
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    // Keep Tab cycling inside the dialog (minimal focus trap).
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusables = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
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
  const id = useId();
  const single = isValidElement(children)
    ? (children as ReactElement<Record<string, unknown> & { id?: string }>)
    : null;
  const isNativeControl =
    single !== null &&
    typeof single.type === "string" &&
    ["input", "select", "textarea"].includes(single.type as string);
  // Associate the visible label with the control; keep any id the caller set.
  const controlId = isNativeControl ? (single!.props.id ?? id) : undefined;
  const control = isNativeControl ? cloneElement(single!, { id: controlId }) : children;
  return (
    <div className="mb-4">
      <label
        htmlFor={controlId}
        className="block text-[var(--step-minus-1)] font-medium text-[var(--muted)] mb-1.5 uppercase tracking-wide"
      >
        {label}
      </label>
      {control}
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

export function ShortId({ id }: { id: string }) {
  return <span className="mono text-[var(--step-minus-1)]" title={id}>{id.length > 18 ? `${id.slice(0, 18)}…` : id}</span>;
}

/* --- Shared table chrome --- */
/* One definition for the flat data-table treatment used by every evidence
 * surface (runs, boards, tasks). Views import these instead of re-declaring
 * near-identical string constants that drift apart over time. */
export const TABLE_SHELL =
  "overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]";
export const TABLE_TH =
  "border-b border-[var(--border)] px-3 py-2 text-left text-[var(--step-minus-1)] font-medium uppercase tracking-wide text-[var(--faint)]";
export const TABLE_TD =
  "border-b border-[var(--border-dim)] px-3 py-2.5 align-top";

/* --- Shared form + evidence chrome --- */
/** Full-width form field input (entity forms, inline modals). */
export const FORM_INPUT =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
/** Compact input variant for dense inline forms. */
export const FORM_INPUT_SM =
  "rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-minus-1)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
/** Mono evidence block (stdout, diffs, roll-up JSON). */
export const LOG_BLOCK =
  "mono mt-3 overflow-x-auto whitespace-pre rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)] leading-relaxed text-[var(--text-soft)]";

/* --- Shared shell tokens --- */
/* One definition per recurring surface (the legacy compat layer, now
 * retired: views import these instead of re-declaring or re-applying). */
export const CARD_SHELL =
  "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm";
export const PILL_SHELL =
  "inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 text-[var(--step-minus-2)] font-medium text-[var(--text-soft)]";
export const CHIP_SHELL =
  "inline-flex items-center rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[var(--step-minus-2)] text-[var(--text-soft)]";
export const ERROR_BOX =
  "rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--step-0)]";
export const FORM_SELECT =
  "rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[var(--step-minus-1)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
/** Mono evidence block without margin (metrics JSON, backup results). */
export const LOG_SHELL =
  "mono overflow-x-auto whitespace-pre rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)] leading-relaxed text-[var(--text-soft)]";

/* --- Shared task tally --- */
/** The one task-status tally: queued = pending | ready, plus running,
 *  blocked, done, failed, cancelled. Unknown statuses are ignored. Every
 *  aggregate surface (workspace summary, team rollups, per-team counts)
 *  derives its numbers through this so the status vocabulary cannot drift. */
export function taskTally(tasks: Task[]): {
  running: number;
  queued: number;
  blocked: number;
  done: number;
  failed: number;
  cancelled: number;
} {
  let running = 0;
  let queued = 0;
  let blocked = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  for (const task of tasks) {
    if (task.status === "running") running += 1;
    else if (task.status === "blocked") blocked += 1;
    else if (task.status === "pending" || task.status === "ready") queued += 1;
    else if (task.status === "done") done += 1;
    else if (task.status === "failed") failed += 1;
    else if (task.status === "cancelled") cancelled += 1;
  }
  return { running, queued, blocked, done, failed, cancelled };
}

/* --- Async --- */

/** Return type of {@link useAsync}. Internal: consumers reference it via
 *  `ReturnType<typeof useAsync>` rather than importing the name. */
interface AsyncState<T> {
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

/** Shape of {@link usePermissionCatalogue}'s result. */
interface PermissionCatalogue {
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
