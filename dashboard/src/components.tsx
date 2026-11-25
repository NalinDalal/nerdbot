import { cloneElement, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ReactNode } from "react";
import { api, describeError } from "./api";
import { BotAvatar } from "./bot/BotAvatar";
import { faceStateFor } from "./bot/status";
import type { StateId } from "./bot/states";
import type { Approval, Permission, Task } from "./types";
import type { BotFace as BotFaceSpec } from "./types";

export function StatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  const tone = statusTone(status);
  const dot =
    tone === "ok"
      ? "bg-[var(--success)]"
      : tone === "bad"
        ? "bg-[var(--danger)]"
        : tone === "warn"
          ? "bg-[var(--warn)]"
          : tone === "info"
            ? "bg-[var(--info)]"
            : "bg-[var(--faint)]";
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-step--1 font-medium text-[var(--text-soft)]">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {label ?? statusLabel(status)}
    </span>
  );
}

/** One vocabulary for task and run states. The same word means the same
 *  status wherever it appears, so a "queued" run and a "pending" task cannot
 *  drift into different labels (or raw enum values) across surfaces. */
const STATUS_LABELS: Record<string, string> = {
  pending: "Queued",
  queued: "Queued",
  ready: "Ready",
  running: "Running",
  done: "Completed",
  succeeded: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  stopped: "Stopped",
  cancelled: "Cancelled",
  awaiting_approval: "Awaiting approval",
  active: "Active",
  denied: "Rejected",
  rejected: "Rejected",
  expired: "Expired",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function taskStatusLabel(status: string): string {
  return statusLabel(status);
}

export function runStatusLabel(status: string): string {
  return statusLabel(status);
}

/* --- Theme --- */

export type Theme = "dark" | "light" | "system";

const THEME_KEY = "nerdbot.theme";
/** Theme changes are app-wide, but each `useTheme` call owns its own state.
 *  This event keeps those instances in step (the terminal repaints from it
 *  rather than rebuilding its PTY session). */
const THEME_EVENT = "nerdbot:theme";

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light" || value === "system";
}

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
      if (isTheme(v)) return v;
    } catch {
      // ignore
    }
    return "dark";
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

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail;
      if (isTheme(next)) setTheme(next);
    };
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);

  const setThemePref = (next: Theme) => {
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // ignore
    }
    window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: next }));
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
      className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-step--1 text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)]"
      aria-label={`Theme: ${label}`}
      title={label}
    >
      <span className="text-step--1">{icon}</span>
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
  width = "data",
}: {
  children: ReactNode;
  className?: string;
  width?: "reading" | "data" | "wide" | "fill";
}) {
  const max =
    width === "reading"
      ? "max-w-[820px]"
      : width === "data"
        ? "max-w-[var(--max-width-wide)]"
        : "max-w-none";
  return (
    <div className={`flex-1 overflow-y-auto overflow-x-hidden bg-[var(--bg)] ${className}`}>
      <div className={`mx-auto w-full ${max} px-5 py-6 md:px-8 md:py-8`}>
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
  description?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; onClick: () => void };
}) {
  return (
    <div className="mb-6 md:mb-8">
      {back ? (
        <button
          onClick={back.onClick}
          className="mb-4 inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-1 py-0.5 text-step--1 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
        >
          <span aria-hidden>←</span> {back.label}
        </button>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-[14rem] flex-1">
          {eyebrow ? (
            <div className="mb-1.5 text-step--1 font-medium text-[var(--faint)]">
              {eyebrow}
            </div>
          ) : null}
          <h1 className="text-step-3 font-semibold leading-[1.15] tracking-[-0.03em] text-[var(--text)]">
            {title}
          </h1>
          {description ? (
            typeof description === "string" ? (
              <p className="mt-2 max-w-[70ch] text-step-0 leading-relaxed text-[var(--muted)]">
                {description}
              </p>
            ) : (
              <div className="mt-2 max-w-[70ch] text-step-0 leading-relaxed text-[var(--muted)]">
                {description}
              </div>
            )
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** A titled block inside a page. One level below the page header, so every
 *  page can group content without inventing its own heading. */
export function PageSection({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mb-8 last:mb-0 ${className}`}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-step-1 font-semibold tracking-[-0.02em] text-[var(--text)]">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 max-w-[70ch] text-step--1 text-[var(--muted)]">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A row of numbers. The fleet and workspace pages use this instead of
 *  paragraphs of counts, so a summary can be scanned in one pass. */
export function StatStrip({
  items,
  className = "",
}: {
  items: Array<{ label: string; value: number | string; tone?: "ok" | "warn" | "bad" | "info" }>;
  className?: string;
}) {
  return (
    <dl className={`flex flex-wrap items-baseline gap-x-6 gap-y-2 ${className}`}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <dt className="sr-only">{item.label}</dt>
          <dd
            className={`text-step-0 font-semibold tabular-nums ${
              item.tone === "bad"
                ? "text-[var(--danger)]"
                : item.tone === "warn"
                  ? "text-[var(--warn)]"
                  : item.tone === "info"
                    ? "text-[var(--info)]"
                    : item.tone === "ok"
                      ? "text-[var(--accent)]"
                      : "text-[var(--text)]"
            }`}
          >
            {item.value}
          </dd>
          <span className="text-step--1 text-[var(--muted)]">{item.label}</span>
        </div>
      ))}
    </dl>
  );
}

/** A command or config value the owner may want to copy. */
export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mono overflow-x-auto rounded-lg border border-[var(--border-dim)] bg-[var(--surface-2)] px-3 py-2 text-step--1 leading-relaxed text-[var(--text-soft)]">
      {children}
    </pre>
  );
}

/** A label and its value, side by side. Settings uses this for facts that
 *  are not prose. */
export function KeyValue({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 py-1.5">
      <dt className="w-44 shrink-0 text-step--1 text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-step--1 text-[var(--text)]">{children}</dd>
    </div>
  );
}

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)] ${className}`}>
      {children}
    </div>
  );
}

/* --- Status dot --- */

export function statusTone(status: string): "ok" | "bad" | "warn" | "info" | "neutral" {
  if (status === "running") return "info";
  if (status === "done" || status === "ready" || status === "active") return "ok";
  if (status === "failed" || status === "denied" || status === "rejected") return "bad";
  if (status === "expired") return "bad";
  if (
    status === "blocked" ||
    status === "pending" ||
    status === "queued" ||
    status === "awaiting_approval"
  ) {
    return "warn";
  }
  return "neutral";
}

/** An approval is pending only while it can still be decided.
 *
 *  An undecided approval past its expiry is dead: the API answers 410 when
 *  you try to decide it. It must not be offered as an actionable decision.
 *  Mirrors `store.approval_is_pending` on the server, so both sides agree on
 *  what "pending" means. */
export function approvalIsPending(
  approval: { decision?: string | null; expires_at?: string | null },
  now: number = Date.now(),
): boolean {
  if ((approval.decision ?? "pending") !== "pending") return false;
  if (!approval.expires_at) return true;
  const expiry = new Date(approval.expires_at).getTime();
  if (Number.isNaN(expiry)) return true;
  return expiry > now;
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
        <span className="text-step--1 text-[var(--text-soft)]">{label}</span>
      ) : null}
    </span>
  );
}

/** A bot's face.
 *
 *  The face the owner picked when they set the bot up: a body shape, a
 *  colour and a resting expression, drawn as an SVG by the bot engine in
 *  `src/bot/`. Nothing is loaded and nothing is derived from the bot id
 *  two bots look different because their owner said so.
 *
 *  A live bot is a whole screen of faces, so the small ones draw a single
 *  frame: twenty animation loops on one page is a page that janks. The
 *  frame is still POSED, though `state` says what the bot is doing, and a
 *  face frozen mid-work still reads as working.
 *
 *  `status` also draws the small status dot, because a caller that has the
 *  word usually wants the glance. A caller that already shows a badge
 *  passes `state` alone and keeps the avatar quiet.
 */
export function BotFace({
  face,
  size = 28,
  status,
  state,
  animated = false,
  className = "",
}: {
  face?: BotFaceSpec | null;
  size?: number;
  status?: string;
  /** The pose, when the caller knows it. Defaults to the status's pose. */
  state?: StateId;
  /** Animate the face. Falls back to a static frame under reduced motion. */
  animated?: boolean;
  className?: string;
}) {
  const tone = status ? statusTone(status) : "neutral";
  const ring =
    tone === "ok"
      ? "var(--accent)"
      : tone === "bad"
        ? "var(--danger)"
        : tone === "warn"
          ? "var(--warn)"
          : tone === "info"
            ? "var(--info)"
            : "var(--faint)";
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <BotAvatar face={face} size={size} state={state ?? faceStateFor(status)} animated={animated} />
      {status ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-[var(--surface)]"
          style={{ width: size * 0.26, height: size * 0.26, background: ring }}
        />
      ) : null}
    </span>
  );
}

export function BotChip({
  persona,
  id,
  status,
  face,
  size = "sm",
  href,
  animated,
}: {
  persona: string;
  id: string;
  status: string;
  face?: BotFaceSpec | null;
  size?: "sm" | "md";
  /** Where the name goes. Omit for a chip that is only a label. */
  href?: string;
  animated?: boolean;
}) {
  const name = persona || "Unnamed";
  const nameClass = "truncate text-step--1 text-[var(--text-soft)]";
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <BotFace face={face} size={size === "md" ? 36 : 28} status={status} animated={animated ?? size === "md"} />
      {href ? (
        <a
          href={href}
          title={id}
          className={`${nameClass} hover:text-[var(--text)] hover:underline`}
        >
          {name}
        </a>
      ) : (
        <span className={nameClass} title={id}>
          {name}
        </span>
      )}
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

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div
        aria-hidden
        className="mb-4 flex h-10 w-10 items-center justify-center rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--faint)]"
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 4h12v12H4z" />
          <path d="M7 8h6M7 11h4" strokeLinecap="round" />
        </svg>
      </div>
      <div className="text-step-1 font-semibold tracking-[-0.01em] text-[var(--text)]">{title}</div>
      {hint ? (
        <div className="mt-2 max-w-[46ch] text-step--1 leading-relaxed text-[var(--muted)]">
          {hint}
        </div>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ lines = 3 }: { lines?: number }) {
  return (
    <div role="status" aria-label="Loading" aria-live="polite" className="flex flex-col gap-2 py-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton h-3.5 rounded-[4px]"
          style={{ width: `${Math.max(38, 100 - i * 13)}%` }}
        />
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = describeError(error);
  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-4 py-3 text-step-0"
    >
      <div>{message}</div>
      {onRetry ? (
        <div className="mt-3">
          <button onClick={onRetry} className="text-step--1 text-[var(--accent)] hover:underline">
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
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        className="animate-fade-in max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-lg)] sm:rounded-[var(--radius-lg)] sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <strong className="text-step-1 font-semibold tracking-[-0.01em] text-[var(--text)]">{title}</strong>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 rounded-[var(--radius-sm)] p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
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
        className="block text-step--1 font-medium text-[var(--muted)] mb-1.5 uppercase tracking-wide"
      >
        {label}
      </label>
      {control}
      {error ? (
        <div className="mt-1.5 text-step--1 text-[var(--danger)]">{error}</div>
      ) : null}
    </div>
  );
}

/* --- Primitive buttons --- */

export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  disabled,
  type = "button",
  className,
  title,
  ariaLabel,
  ariaBusy,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  className?: string;
  title?: string;
  /** Use when the visible text is hidden at small breakpoints. */
  ariaLabel?: string;
  ariaBusy?: boolean;
}) {
  const base =
    "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)] active:translate-y-px";
  const sizes: Record<string, string> = {
    sm: "h-7 px-2.5 text-step--1",
    md: "h-[34px] px-3 text-step--1",
  };
  const variants: Record<string, string> = {
    default:
      "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]",
    primary:
      "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-press)]",
    danger:
      "border-transparent bg-transparent text-[var(--danger)] hover:border-[var(--danger)] hover:bg-[var(--danger-dim)]",
    ghost:
      "border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-busy={ariaBusy}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className || ""}`}
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
  const tone =
    variant === "ok"
      ? "border-transparent bg-[var(--success-dim)] text-[var(--success)]"
      : variant === "bad"
        ? "border-transparent bg-[var(--danger-dim)] text-[var(--danger)]"
        : variant === "warn"
          ? "border-transparent bg-[var(--warn-dim)] text-[var(--warn)]"
          : variant === "info"
            ? "border-transparent bg-[var(--info-dim)] text-[var(--info)]"
            : "border-[var(--border-dim)] bg-transparent text-[var(--muted)]";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 py-0.5 text-step--2 font-medium ${tone}`}
    >
      {children}
    </span>
  );
}

export function ShortId({ id }: { id: string }) {
  return <span className="mono text-step--1" title={id}>{id.length > 18 ? `${id.slice(0, 18)}…` : id}</span>;
}

/* --- Approvals --- */

/** What an approval is waiting for, in one word. */
export function approvalStateLabel(state: string): string {
  if (state === "pending") return "Awaiting you";
  if (state === "expired") return "Expired";
  if (state === "approved" || state === "approved_forever") return "Approved";
  if (state === "denied") return "Rejected";
  return state;
}

/**
 * The state of an approval, from the server's rule: an undecided request
 * whose time is up is DEAD not pending deciding it would fail. It still
 * has to be visible, because a request nobody answered is exactly the kind
 * of silence that makes a workspace feel stuck.
 */
export function approvalState(approval: {
  decision?: string | null;
  expires_at?: string | null;
}): "pending" | "expired" | "resolved" {
  if ((approval.decision ?? "pending") !== "pending") return "resolved";
  if (!approval.expires_at) return "pending";
  const expiry = new Date(approval.expires_at).getTime();
  if (Number.isNaN(expiry)) return "pending";
  return expiry > Date.now() ? "pending" : "expired";
}

export function ApprovalStateBadge({ state }: { state: string }) {
  const variant =
    state === "pending"
      ? "warn"
      : state === "expired"
        ? "bad"
        : state === "approved" || state === "approved_forever"
          ? "ok"
          : state === "denied"
            ? "neutral"
            : "info";
  return <Badge variant={variant}>{approvalStateLabel(state)}</Badge>;
}

/** The three answers the owner can give, and nothing else.
 *
 *  "Forever" is a reusable permit for the same exact action; it is not a
 *  blanket permission, and the row that carries it says which action it is
 *  bound to. */
export function ApprovalDecisionButtons({
  onDecide,
  busy,
  size = "md",
}: {
  onDecide: (decision: "approved" | "approved_forever" | "denied") => void;
  busy?: boolean;
  size?: "sm" | "md";
}) {
  const label = size === "sm" ? "text-step--2" : "text-step--1";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => onDecide("approved")}
        className={label}
      >
        Approve once
      </Button>
      <Button disabled={busy} onClick={() => onDecide("approved_forever")} className={label}>
        Forever
      </Button>
      <Button variant="danger" disabled={busy} onClick={() => onDecide("denied")} className={label}>
        Reject
      </Button>
    </div>
  );
}

/**
 * One approval, and what the owner can do about it.
 *
 * The state is the point: a request whose time is up is DEAD, not pending, so
 * it says so and offers the way to ask again instead of a decision that
 * would fail.
 */
export function ApprovalRow({
  approval,
  busy = false,
  onDecide,
  onReask,
}: {
  approval: Approval & {
    teammate_persona?: string;
    task_description?: string;
    performed?: boolean;
  };
  busy?: boolean;
  onDecide?: (decision: "approved" | "approved_forever" | "denied") => void;
  onReask?: () => void;
}) {
  const state = approvalState(approval);
  const askedBy = approval.teammate_persona || approval.requester || "the workspace";
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-step-0 text-[var(--text)]">{approval.action}</strong>
            <ApprovalStateBadge state={state} />
            {approval.tool_name ? (
              <span className="text-step--2 text-[var(--faint)]">
                {approval.performed ? "action performed" : "action not performed yet"}
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-step--1 text-[var(--muted)]">
            asked by {askedBy}
            {approval.task_description ? ` · ${approval.task_description}` : ""}
          </div>
          {approval.digest ? (
            <div className="mono mt-0.5 text-step--2 text-[var(--faint)]">
              digest {approval.digest.slice(0, 16)}…
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {state === "pending" && onDecide ? (
            <ApprovalDecisionButtons onDecide={onDecide} busy={busy} size="sm" />
          ) : state === "expired" && onReask ? (
            <Button onClick={onReask} disabled={busy}>
              Ask again
            </Button>
          ) : (
            <span className="text-step--2 text-[var(--faint)]">
              {approval.decided_at ? relativeTime(approval.decided_at) : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* --- Shared table chrome --- */
/* One definition for the flat data-table treatment used by every evidence
 * surface (runs, boards, tasks). Views import these instead of re-declaring
 * near-identical string constants that drift apart over time. */
export const TABLE_SHELL =
  "overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]";
export const TABLE_TH =
  "border-b border-[var(--border)] px-3 py-2 text-left text-step--1 font-medium uppercase tracking-wide text-[var(--faint)]";
export const TABLE_TD =
  "border-b border-[var(--border-dim)] px-3 py-2.5 align-top";

/* --- Shared form + evidence chrome --- */
/** Full-width form field input (entity forms, inline modals). */
export const FORM_INPUT =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
/** Compact input variant for dense inline forms. */
export const FORM_INPUT_SM =
  "rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
/** Mono evidence block (stdout, diffs, roll-up JSON). */
export const LOG_BLOCK =
  "mono mt-3 overflow-x-auto whitespace-pre rounded-lg bg-[var(--surface-2)] px-3 py-2 text-step--1 leading-relaxed text-[var(--text-soft)]";

/* --- Shared shell tokens --- */
/* One definition per recurring surface (the legacy compat layer, now
 * retired: views import these instead of re-declaring or re-applying). */
export const CARD_SHELL =
  "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm";
export const PILL_SHELL =
  "inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 text-step--2 font-medium text-[var(--text-soft)]";
export const CHIP_SHELL =
  "inline-flex items-center rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-step--2 text-[var(--text-soft)]";
export const ERROR_BOX =
  "rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step-0";
export const FORM_SELECT =
  "rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
/** Mono evidence block without margin (metrics JSON, backup results). */
export const LOG_SHELL =
  "mono overflow-x-auto whitespace-pre rounded-lg bg-[var(--surface-2)] px-3 py-2 text-step--1 leading-relaxed text-[var(--text-soft)]";

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
  /** Waiting on a human decision. Not blocked: the work is fine, the
   *  answer is missing. */
  awaiting: number;
} {
  let running = 0;
  let queued = 0;
  let blocked = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  let awaiting = 0;
  for (const task of tasks) {
    if (task.status === "running") running += 1;
    else if (task.status === "awaiting_approval") awaiting += 1;
    else if (task.status === "blocked") blocked += 1;
    else if (task.status === "pending" || task.status === "ready") queued += 1;
    else if (task.status === "done") done += 1;
    else if (task.status === "failed") failed += 1;
    else if (task.status === "cancelled") cancelled += 1;
  }
  return { running, queued, blocked, done, failed, cancelled, awaiting };
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

interface AsyncSnapshot<T> {
  key: string;
  data: T | null;
  error: unknown;
  loading: boolean;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify([nonce, ...deps]);
  const [snapshot, setSnapshot] = useState<AsyncSnapshot<T> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fn().then(
      (result) => {
        if (!cancelled) {
          setSnapshot({ key, data: result, error: null, loading: false });
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          /* Keep the last good answer behind the error. Panels can show what
           * they already know instead of collapsing to a blank state. */
          setSnapshot((previous) => ({
            key,
            data: previous?.data ?? null,
            error: err,
            loading: false,
          }));
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);
  /* A key change is a new request even before its promise settles: report it
   * as loading with the previous answer still available, rather than showing
   * another workspace's data as if it were current. */
  const current = snapshot?.key === key ? snapshot : null;
  const data = current ? current.data : (snapshot?.data ?? null);
  const error = current ? current.error : null;
  const loading = current ? current.loading : true;
  /* A stable result keeps callers' effects and callbacks from re-running on
   * every render of the view that owns the loader. */
  return useMemo(() => ({ data, error, loading, reload }), [data, error, loading, reload]);
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

/* --- Icon system ---
 *
 * One family: 16px box, 1.5 stroke, round caps. Every icon is ornamental
 * unless the control has no text label, in which case the control carries
 * an aria-label. Never mix filled and stroked icons in one surface.
 */
export type IconName =
  | "home"
  | "chat"
  | "work"
  | "agents"
  | "teams"
  | "projects"
  | "library"
  | "settings"
  | "plus"
  | "search"
  | "chevron-down"
  | "chevron-right"
  | "command"
  | "sun"
  | "moon"
  | "monitor"
  | "menu"
  | "close"
  | "arrow-right"
  | "alert"
  | "check"
  | "clock"
  | "play"
  | "pause"
  | "rotate"
  | "external"
  | "more"
  | "filter"
  | "download"
  | "upload"
  | "folder"
  | "document"
  | "spark"
  | "activity"
  | "lock"
  | "plug"
  | "cpu"
  | "layers"
  | "target"
  | "inbox"
  | "book"
  | "users"
  | "stop";

const ICON_PATHS: Record<IconName, ReactNode> = {
  home: <path d="M2.5 7 8 2.5 13.5 7v6.5h-4v-4h-3v4h-4z" />,
  chat: <path d="M2.5 3.5h11v7h-6.2L4.5 13v-2.5h-2z" />,
  work: <><rect x="2.5" y="3.5" width="11" height="9" rx="1" /><path d="M5.5 3.5V2h5v1.5M2.5 7h11" /></>,
  agents: <><circle cx="6" cy="5.5" r="2.25" /><path d="M1.5 13c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5M10.5 3.6a2 2 0 0 1 0 3.8M11.5 9.8c1.8.3 3 1.4 3 3.2" /></>,
  teams: <><path d="M5.5 13.5V9.5h5v4M2 13.5V7l6-3 6 3v6.5" /><path d="M6.5 7h3" /></>,
  projects: <path d="M2.5 4.5h4l1.2 1.5h5.8v7.5h-11zM2.5 4.5V3h4" />,
  library: <><rect x="2.5" y="3.5" width="3" height="9" rx=".5" /><rect x="6.5" y="3.5" width="3" height="9" rx=".5" /><path d="m10.9 4.1 2.6.7-2.3 8.3-2.6-.7z" /></>,
  settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  search: <><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></>,
  "chevron-down": <path d="m4 6 4 4 4-4" />,
  "chevron-right": <path d="m6 4 4 4-4 4" />,
  command: <path d="M6 2.5A1.75 1.75 0 1 1 6 6h4a1.75 1.75 0 1 1 0-3.5v7.5A1.75 1.75 0 1 1 6 10h4a1.75 1.75 0 1 1 0 3.5V6H6z" />,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M12.6 3.4l-.7.7M4.1 11.9l-.7.7" /></>,
  moon: <path d="M13 9.3A5.4 5.4 0 0 1 6.7 3a5.4 5.4 0 1 0 6.3 6.3z" />,
  monitor: <><rect x="2" y="3" width="12" height="8" rx="1" /><path d="M6 13h4M8 11v2" /></>,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  "arrow-right": <path d="M3 8h10M9 4l4 4-4 4" />,
  alert: <><path d="M8 2.5 14 13H2z" /><path d="M8 6.5v3M8 11.5h.01" /></>,
  check: <path d="m3 8.5 3.2 3L13 4.5" />,
  clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.3l2.2 1.3" /></>,
  play: <path d="M5.5 3.5 12.5 8l-7 4.5z" />,
  pause: <path d="M6 3.5v9M10 3.5v9" />,
  rotate: <><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13.5 2.5v3h-3" /></>,
  external: <path d="M9.5 2.5H13.5v4M13 3 7.5 8.5M12 10v3.5H2.5V4H6" />,
  more: <><circle cx="3.5" cy="8" r=".8" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r=".8" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r=".8" fill="currentColor" stroke="none" /></>,
  filter: <path d="M2.5 3.5h11L9.5 8.3v4.2l-3 1V8.3z" />,
  download: <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11" />,
  upload: <path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6M2.5 13.5h11" />,
  folder: <path d="M2 4h4l1 1.5h7v8H2z" />,
  document: <><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3M6 8h4M6 10.5h4" /></>,
  spark: <path d="M8 1.5 9.3 6l4.2 2-4.2 2L8 14.5 6.7 10 2.5 8l4.2-2z" />,
  activity: <path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" />,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  plug: <path d="M5 2.5v4M11 2.5v4M3 6.5h10v2a5 5 0 0 1-10 0zM8 13.5v1" />,
  cpu: <><rect x="4" y="4" width="8" height="8" rx="1" /><rect x="6.5" y="6.5" width="3" height="3" /><path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2" /></>,
  layers: <path d="m8 2 6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3" />,
  target: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2.5" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2" /></>,
  inbox: <><path d="M2.5 9.5 4 3.5h8l1.5 6v3h-11z" /><path d="M2.5 9.5H6l.6 1.5h2.8l.6-1.5h3.5" /></>,
  book: <path d="M3 2.5h9.5v11H3zM5 2.5v11M7.5 5.5h3" />,
  users: <><circle cx="5.5" cy="5.5" r="2" /><circle cx="11.5" cy="6.5" r="1.6" /><path d="M1.5 13c0-1.9 1.8-3.2 4-3.2s4 1.3 4 3.2M10 9.9c1.6.2 2.8 1.2 2.8 3.1" /></>,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
};

export function Icon({
  name,
  className = "h-4 w-4",
  strokeWidth = 1.5,
}: {
  name: IconName;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mono inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-[var(--border)] bg-[var(--surface-2)] px-1 text-[10px] leading-none text-[var(--faint)]">
      {children}
    </kbd>
  );
}

/** Agent identity: the chosen face when one exists, initials otherwise.
 *  Always paired with a text name nearby, never the only identifier. */
export function AgentAvatar({
  name,
  face,
  size = 28,
  status,
}: {
  name: string;
  face?: BotFaceSpec | null;
  size?: number;
  status?: string;
}) {
  if (face) return <BotFace face={face} size={size} status={status} />;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] font-medium text-[var(--muted)]"
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.36) }}
      title={name}
      aria-hidden
    >
      {initials || "?"}
    </span>
  );
}

/** A single inline fact. Use the label as the unit, not a decorative icon. */
export function InlineStat({
  value,
  label,
  tone = "neutral",
}: {
  value: ReactNode;
  label: string;
  tone?: "neutral" | "ok" | "warn" | "bad";
}) {
  const color =
    tone === "bad"
      ? "text-[var(--danger)]"
      : tone === "warn"
        ? "text-[var(--warn)]"
        : tone === "ok"
          ? "text-[var(--success)]"
          : "text-[var(--text)]";
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`text-step-0 font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-step--1 text-[var(--muted)]">{label}</span>
    </span>
  );
}

/** Consistent toolbar above lists and tables. It is a flex row, not a card. */
export function Toolbar({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mb-3 flex flex-wrap items-center gap-2 ${className}`}>{children}</div>
  );
}
