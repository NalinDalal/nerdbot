import { cloneElement, isValidElement, useEffect, useRef, useState, useId } from "react";
import type { ReactElement } from "react";
import type { ReactNode } from "react";
import { api, describeError } from "./api";
import { BotAvatar } from "./bot/BotAvatar";
import type { Approval, Permission, Task } from "./types";
import type { BotFace as BotFaceSpec } from "./types";

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
    blocked: "Blocked",
    cancelled: "Cancelled",
    awaiting_approval: "Awaiting approval",
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
    awaiting_approval: "Awaiting approval",
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
      {/* pl-14 on mobile reserves the gutter the fixed menu button floats in
          (app.tsx: `fixed left-3 top-3`), so a page heading is never
          painted underneath it. md:px-8 releases the gutter on desktop. */}
      <div className="mx-auto w-full max-w-[var(--max-width-wide)] py-6 pl-14 pr-6 md:px-8 md:py-8">
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
    <div className="mb-8">
      {back ? (
        <button
          onClick={back.onClick}
          className="mb-3 inline-flex items-center gap-1 text-[var(--step-minus-1)] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
        >
          <span aria-hidden>←</span> {back.label}
        </button>
      ) : null}
      {/* The title block grows but shrinks, so the actions stay on the right
          instead of wrapping under the description on a wide window. */}
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-[14rem] flex-1">
          {eyebrow ? (
            <div className="mb-1 text-[var(--step-minus-2)] uppercase tracking-[0.16em] text-[var(--faint)]">
              {eyebrow}
            </div>
          ) : null}
          <h1 className="text-[var(--step-1)] font-semibold tracking-tight text-[var(--text)]">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-[68ch] text-[var(--step-0)] text-[var(--muted)] leading-relaxed">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
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
    <section className={`mb-10 last:mb-0 ${className}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-[var(--step-0)] font-semibold tracking-tight text-[var(--text)]">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 max-w-[68ch] text-[var(--step-minus-1)] text-[var(--muted)]">
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
            className={`text-[var(--step-0)] font-semibold tabular-nums ${
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
          <span className="text-[var(--step-minus-1)] text-[var(--muted)]">{item.label}</span>
        </div>
      ))}
    </dl>
  );
}

/** A command or config value the owner may want to copy. */
export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mono overflow-x-auto rounded-lg border border-[var(--border-dim)] bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)] leading-relaxed text-[var(--text-soft)]">
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
      <dt className="w-44 shrink-0 text-[var(--step-minus-1)] text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-[var(--step-minus-1)] text-[var(--text)]">{children}</dd>
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
  if (
    status === "blocked" ||
    status === "pending" ||
    status === "queued" ||
    status === "awaiting_approval"
  ) {
    return "warn";
  }
  if (status === "expired") return "bad";
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
        <span className="text-[var(--step-minus-1)] text-[var(--text-soft)]">{label}</span>
      ) : null}
    </span>
  );
}

/** A bot's face.
 *
 *  The face the owner picked when they set the bot up: a body shape, a
 *  colour and a resting expression, drawn as an SVG by the bot engine in
 *  `src/bot/`. Nothing is loaded and nothing is derived from the bot id —
 *  two bots look different because their owner said so.
 *
 *  A live bot is a whole screen of faces, so the small ones draw a single
 *  frame: twenty animation loops on one page is a page that janks.
 */
export function BotFace({
  face,
  size = 28,
  status,
  className = "",
}: {
  face?: BotFaceSpec | null;
  size?: number;
  status?: string;
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
      <BotAvatar face={face} size={size} />
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
}: {
  persona: string;
  id: string;
  status: string;
  face?: BotFaceSpec | null;
  size?: "sm" | "md";
}) {
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <BotFace face={face} size={size === "md" ? 36 : 28} status={status} />
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
 * whose time is up is DEAD, not pending — deciding it would fail. It still
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
  const label = size === "sm" ? "text-[var(--step-minus-2)]" : "text-[var(--step-minus-1)]";
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
            <strong className="text-[var(--step-0)] text-[var(--text)]">{approval.action}</strong>
            <ApprovalStateBadge state={state} />
            {approval.tool_name ? (
              <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
                {approval.performed ? "action performed" : "action not performed yet"}
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[var(--step-minus-1)] text-[var(--muted)]">
            asked by {askedBy}
            {approval.task_description ? ` · ${approval.task_description}` : ""}
          </div>
          {approval.digest ? (
            <div className="mono mt-0.5 text-[var(--step-minus-2)] text-[var(--faint)]">
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
            <span className="text-[var(--step-minus-2)] text-[var(--faint)]">
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
