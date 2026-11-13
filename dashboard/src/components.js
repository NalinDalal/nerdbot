import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cloneElement, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, describeError } from "./api";
import { BotAvatar } from "./bot/BotAvatar";
import { faceStateFor } from "./bot/status";
export function StatusBadge({ status, label, }) {
    const tone = statusTone(status);
    const dot = tone === "ok"
        ? "bg-[var(--accent)]"
        : tone === "bad"
            ? "bg-[var(--danger)]"
            : tone === "warn"
                ? "bg-[var(--warn)]"
                : tone === "info"
                    ? "bg-[var(--info)]"
                    : "bg-[var(--faint)]";
    return (_jsxs("span", { className: `inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-step--1 font-medium border border-transparent bg-[var(--surface-2)]`, children: [_jsx("span", { className: `w-1.5 h-1.5 rounded-full ${dot}` }), label ?? statusLabel(status)] }));
}
/** One vocabulary for task and run states. The same word means the same
 *  status wherever it appears, so a "queued" run and a "pending" task cannot
 *  drift into different labels (or raw enum values) across surfaces. */
const STATUS_LABELS = {
    pending: "Queued",
    queued: "Queued",
    ready: "Ready",
    running: "Running",
    done: "Completed",
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
export function statusLabel(status) {
    return STATUS_LABELS[status] ?? status;
}
export function taskStatusLabel(status) {
    return statusLabel(status);
}
export function runStatusLabel(status) {
    return statusLabel(status);
}
const THEME_KEY = "nerdbot.theme";
/** Theme changes are app-wide, but each `useTheme` call owns its own state.
 *  This event keeps those instances in step (the terminal repaints from it
 *  rather than rebuilding its PTY session). */
const THEME_EVENT = "nerdbot:theme";
function isTheme(value) {
    return value === "dark" || value === "light" || value === "system";
}
function resolveTheme(theme) {
    if (theme === "system") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return theme;
}
export function useTheme() {
    const stored = (() => {
        try {
            const v = localStorage.getItem(THEME_KEY);
            if (isTheme(v))
                return v;
        }
        catch {
            // ignore
        }
        return "system";
    })();
    const [theme, setTheme] = useState(stored);
    const resolved = resolveTheme(theme);
    useEffect(() => {
        const root = document.documentElement;
        root.removeAttribute("data-theme");
        root.classList.remove("dark", "light");
        if (resolved === "dark") {
            root.classList.add("dark");
        }
        else {
            root.setAttribute("data-theme", "light");
            root.classList.add("light");
        }
    }, [resolved]);
    useEffect(() => {
        const onChange = (event) => {
            const next = event.detail;
            if (isTheme(next))
                setTheme(next);
        };
        window.addEventListener(THEME_EVENT, onChange);
        return () => window.removeEventListener(THEME_EVENT, onChange);
    }, []);
    const setThemePref = (next) => {
        setTheme(next);
        try {
            localStorage.setItem(THEME_KEY, next);
        }
        catch {
            // ignore
        }
        window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: next }));
    };
    return { theme, resolved, setTheme: setThemePref };
}
export function ThemeButton({ onThemeChange }) {
    const [index, setIndex] = useState(0);
    const cycle = ["dark", "light", "system"];
    const current = cycle[index];
    const label = current === "system" ? "System" : current === "dark" ? "Dark" : "Light";
    const icon = current === "system" ? "⭘" : current === "dark" ? "●" : "○";
    return (_jsxs("button", { onClick: () => {
            const next = (index + 1) % cycle.length;
            setIndex(next);
            onThemeChange(cycle[next]);
        }, className: "inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-step--1 text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)]", "aria-label": `Theme: ${label}`, title: label, children: [_jsx("span", { className: "text-step--1", children: icon }), _jsx("span", { className: "sr-only", children: label })] }));
}
/* --- Page primitives --- */
/** Standard scroll container + header for a full-page view. Rebuilt views all
 *  use this shell so the product feels like one surface, not sewn parts. */
export function Page({ children, className = "", width = "data", }) {
    const max = width === "reading" ? "max-w-[880px]" : width === "data" ? "max-w-[1280px]" : "max-w-none";
    /* `fill` keeps the page gutters; only the max-width is waived, so a
       full-width view still clears the sidebar and the window edge. */
    const pad = "px-4 py-6 pl-14 md:px-8 md:py-8";
    return (_jsx("div", { className: `flex-1 overflow-y-auto overflow-x-hidden ${className}`, children: _jsx("div", { className: `mx-auto w-full ${max} ${pad}`, children: children }) }));
}
export function PageHeader({ eyebrow, title, description, actions, back, }) {
    return (_jsxs("div", { className: "mb-8", children: [back ? (_jsxs("button", { onClick: back.onClick, className: "mb-3 inline-flex items-center gap-1 text-step--1 text-[var(--muted)] hover:text-[var(--text)] transition-colors", children: [_jsx("span", { "aria-hidden": true, children: "\u2190" }), " ", back.label] })) : null, _jsxs("div", { className: "flex flex-wrap items-start justify-between gap-x-8 gap-y-3", children: [_jsxs("div", { className: "min-w-[14rem] flex-1", children: [eyebrow ? (_jsx("div", { className: "mb-1 text-step--2 uppercase tracking-[0.16em] text-[var(--faint)]", children: eyebrow })) : null, _jsx("h1", { className: "text-step-1 font-semibold tracking-tight text-[var(--text)]", children: title }), description ? (typeof description === "string" ? (_jsx("p", { className: "mt-1 max-w-[68ch] text-step-0 text-[var(--muted)] leading-relaxed", children: description })) : (_jsx("div", { className: "mt-1 max-w-[68ch] text-step-0 text-[var(--muted)] leading-relaxed", children: description }))) : null] }), actions ? _jsx("div", { className: "flex shrink-0 items-center gap-2", children: actions }) : null] })] }));
}
/** A titled block inside a page. One level below the page header, so every
 *  page can group content without inventing its own heading. */
export function PageSection({ title, description, actions, children, className = "", }) {
    return (_jsxs("section", { className: `mb-10 last:mb-0 ${className}`, children: [_jsxs("div", { className: "mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("h2", { className: "text-step-0 font-semibold tracking-tight text-[var(--text)]", children: title }), description ? (_jsx("p", { className: "mt-0.5 max-w-[68ch] text-step--1 text-[var(--muted)]", children: description })) : null] }), actions ? _jsx("div", { className: "flex shrink-0 items-center gap-2", children: actions }) : null] }), children] }));
}
/** A row of numbers. The fleet and workspace pages use this instead of
 *  paragraphs of counts, so a summary can be scanned in one pass. */
export function StatStrip({ items, className = "", }) {
    return (_jsx("dl", { className: `flex flex-wrap items-baseline gap-x-6 gap-y-2 ${className}`, children: items.map((item) => (_jsxs("div", { className: "flex items-baseline gap-1.5", children: [_jsx("dt", { className: "sr-only", children: item.label }), _jsx("dd", { className: `text-step-0 font-semibold tabular-nums ${item.tone === "bad"
                        ? "text-[var(--danger)]"
                        : item.tone === "warn"
                            ? "text-[var(--warn)]"
                            : item.tone === "info"
                                ? "text-[var(--info)]"
                                : item.tone === "ok"
                                    ? "text-[var(--accent)]"
                                    : "text-[var(--text)]"}`, children: item.value }), _jsx("span", { className: "text-step--1 text-[var(--muted)]", children: item.label })] }, item.label))) }));
}
/** A command or config value the owner may want to copy. */
export function CodeBlock({ children }) {
    return (_jsx("pre", { className: "mono overflow-x-auto rounded-lg border border-[var(--border-dim)] bg-[var(--surface-2)] px-3 py-2 text-step--1 leading-relaxed text-[var(--text-soft)]", children: children }));
}
/** A label and its value, side by side. Settings uses this for facts that
 *  are not prose. */
export function KeyValue({ label, children, }) {
    return (_jsxs("div", { className: "flex flex-wrap items-baseline gap-x-4 gap-y-0.5 py-1.5", children: [_jsx("dt", { className: "w-44 shrink-0 text-step--1 text-[var(--muted)]", children: label }), _jsx("dd", { className: "min-w-0 flex-1 text-step--1 text-[var(--text)]", children: children })] }));
}
export function SectionLabel({ children, className = "" }) {
    return (_jsx("div", { className: `text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)] ${className}`, children: children }));
}
/* --- Status dot --- */
export function statusTone(status) {
    if (status === "running")
        return "info";
    if (status === "done" || status === "ready" || status === "active")
        return "ok";
    if (status === "failed" || status === "denied" || status === "rejected")
        return "bad";
    if (status === "expired")
        return "bad";
    if (status === "blocked" ||
        status === "pending" ||
        status === "queued" ||
        status === "awaiting_approval") {
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
export function approvalIsPending(approval, now = Date.now()) {
    if ((approval.decision ?? "pending") !== "pending")
        return false;
    if (!approval.expires_at)
        return true;
    const expiry = new Date(approval.expires_at).getTime();
    if (Number.isNaN(expiry))
        return true;
    return expiry > now;
}
export function StatusDot({ status, label, pulse = false, }) {
    const tone = statusTone(status);
    const color = tone === "ok" ? "bg-[var(--accent)]" : tone === "bad" ? "bg-[var(--danger)]" : tone === "warn" ? "bg-[var(--warn)]" : tone === "info" ? "bg-[var(--info)]" : "bg-[var(--faint)]";
    return (_jsxs("span", { className: "inline-flex items-center gap-1.5", title: label ?? status, children: [_jsx("span", { className: `h-[7px] w-[7px] rounded-full ${color} ${pulse ? "animate-pulse" : ""}` }), label ? (_jsx("span", { className: "text-step--1 text-[var(--text-soft)]", children: label })) : null] }));
}
/** A bot's face.
 *
 *  The face the owner picked when they set the bot up: a body shape, a
 *  colour and a resting expression, drawn as an SVG by the bot engine in
 *  `src/bot/`. Nothing is loaded and nothing is derived from the bot id —
 *  two bots look different because their owner said so.
 *
 *  A live bot is a whole screen of faces, so the small ones draw a single
 *  frame: twenty animation loops on one page is a page that janks. The
 *  frame is still POSED, though — `state` says what the bot is doing, and a
 *  face frozen mid-work still reads as working.
 *
 *  `status` also draws the small status dot, because a caller that has the
 *  word usually wants the glance. A caller that already shows a badge
 *  passes `state` alone and keeps the avatar quiet.
 */
export function BotFace({ face, size = 28, status, state, animated = false, className = "", }) {
    const tone = status ? statusTone(status) : "neutral";
    const ring = tone === "ok"
        ? "var(--accent)"
        : tone === "bad"
            ? "var(--danger)"
            : tone === "warn"
                ? "var(--warn)"
                : tone === "info"
                    ? "var(--info)"
                    : "var(--faint)";
    return (_jsxs("span", { className: `relative inline-flex shrink-0 items-center justify-center ${className}`, style: { width: size, height: size }, "aria-hidden": true, children: [_jsx(BotAvatar, { face: face, size: size, state: state ?? faceStateFor(status), animated: animated }), status ? (_jsx("span", { className: "absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-[var(--surface)]", style: { width: size * 0.26, height: size * 0.26, background: ring } })) : null] }));
}
export function BotChip({ persona, id, status, face, size = "sm", href, animated, }) {
    const name = persona || "Unnamed";
    const nameClass = "truncate text-step--1 text-[var(--text-soft)]";
    return (_jsxs("span", { className: "inline-flex min-w-0 items-center gap-2", children: [_jsx(BotFace, { face: face, size: size === "md" ? 36 : 28, status: status, animated: animated ?? size === "md" }), href ? (_jsx("a", { href: href, title: id, className: `${nameClass} hover:text-[var(--text)] hover:underline`, children: name })) : (_jsx("span", { className: nameClass, title: id, children: name }))] }));
}
/** Human "3m ago" style timestamp; falls back to the raw string. */
export function relativeTime(iso) {
    const ts = new Date(iso).getTime();
    if (!Number.isFinite(ts) || !iso)
        return "";
    const diff = Date.now() - ts;
    if (diff < 0)
        return "just now";
    const mins = Math.round(diff / 60000);
    if (mins < 1)
        return "just now";
    if (mins < 60)
        return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
}
/* --- Empty / loading / error states --- */
export function EmptyState({ title, hint, action }) {
    return (_jsxs("div", { className: "flex flex-col items-center justify-center px-6 py-10 text-center", children: [_jsx("div", { className: "text-step-1 font-semibold text-[var(--text)]", children: title }), hint ? (_jsx("div", { className: "mt-3 text-step-0 text-[var(--muted)] leading-1.5 max-w-[42ch]", children: hint })) : null, action ? (_jsx("div", { className: "mt-6", children: action })) : null] }));
}
export function LoadingState({ lines = 3 }) {
    return (_jsx("div", { role: "status", "aria-label": "Loading", "aria-live": "polite", className: "flex flex-col gap-1.5", children: Array.from({ length: lines }).map((_, i) => (_jsx("div", { className: "h-3.5 w-full rounded-sm bg-[var(--surface-2)] animate-shimmer" }, i))) }));
}
export function ErrorState({ error, onRetry }) {
    const message = describeError(error);
    return (_jsxs("div", { role: "alert", className: "rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-4 py-3 text-step-0", children: [_jsx("div", { children: message }), onRetry ? (_jsx("div", { className: "mt-3", children: _jsx("button", { onClick: onRetry, className: "text-step--1 text-[var(--accent)] hover:underline", children: "Retry" }) })) : null] }));
}
/* --- Modal --- */
export function Modal({ title, children, onClose }) {
    const panelRef = useRef(null);
    useEffect(() => {
        // Move focus to the first sensible control while open; restore it on close.
        const previous = document.activeElement;
        const panel = panelRef.current;
        const selector = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const firstInput = panel?.querySelector("textarea, input, select");
        const first = firstInput ?? panel?.querySelector(selector);
        first?.focus();
        return () => {
            previous?.focus();
        };
    }, []);
    const handleKeyDown = (e) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
            return;
        }
        // Keep Tab cycling inside the dialog (minimal focus trap).
        if (e.key !== "Tab" || !panelRef.current)
            return;
        const focusables = Array.from(panelRef.current.querySelectorAll('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        if (focusables.length === 0)
            return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        }
        else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    return (_jsx("div", { className: "fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm", onClick: onClose, onKeyDown: handleKeyDown, children: _jsxs("div", { ref: panelRef, className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-lg", role: "dialog", "aria-modal": "true", "aria-label": title, onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsx("strong", { className: "text-step-1 font-semibold", children: title }), _jsx("button", { onClick: onClose, "aria-label": "Close", className: "rounded-sm p-1.5 text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition-colors", children: "\u00D7" })] }), children] }) }));
}
/* --- Field --- */
export function Field({ label, error, children, }) {
    const id = useId();
    const single = isValidElement(children)
        ? children
        : null;
    const isNativeControl = single !== null &&
        typeof single.type === "string" &&
        ["input", "select", "textarea"].includes(single.type);
    // Associate the visible label with the control; keep any id the caller set.
    const controlId = isNativeControl ? (single.props.id ?? id) : undefined;
    const control = isNativeControl ? cloneElement(single, { id: controlId }) : children;
    return (_jsxs("div", { className: "mb-4", children: [_jsx("label", { htmlFor: controlId, className: "block text-step--1 font-medium text-[var(--muted)] mb-1.5 uppercase tracking-wide", children: label }), control, error ? (_jsx("div", { className: "mt-1.5 text-step--1 text-[var(--danger)]", children: error })) : null] }));
}
/* --- Primitive buttons --- */
export function Button({ children, onClick, variant = "default", disabled, type = "button", className, title, ariaLabel, }) {
    const base = "inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-step--1 font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)] max-lg:min-h-11";
    const variants = {
        default: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:border-[var(--faint)] hover:text-[var(--text)]",
        primary: "bg-[var(--accent)] border-[var(--accent)] text-[var(--text-inverse)] font-semibold hover:bg-[var(--accent-hover)] hover:border-[var(--accent-hover)]",
        danger: "border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger-dim)]",
        ghost: "border-transparent bg-transparent text-[var(--text-soft)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
    };
    return (_jsx("button", { type: type, onClick: onClick, disabled: disabled, title: title, "aria-label": ariaLabel, className: `${base} ${variants[variant]} ${className || ""}`, children: children }));
}
/* --- Badge --- */
export function Badge({ children, variant = "neutral", }) {
    const bg = variant === "ok" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : variant === "bad" ? "bg-[var(--danger-dim)] text-[var(--danger)]" : variant === "warn" ? "bg-[var(--warn-dim)] text-[var(--warn)]" : variant === "info" ? "bg-[var(--info-dim)] text-[var(--info)]" : "bg-[var(--surface-2)] text-[var(--muted)]";
    const dot = variant === "ok"
        ? "bg-[var(--accent)]"
        : variant === "bad"
            ? "bg-[var(--danger)]"
            : variant === "warn"
                ? "bg-[var(--warn)]"
                : "bg-[var(--info)]";
    return (_jsxs("span", { className: `inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-0.5 text-step--1 font-medium ${bg}`, children: [variant === "neutral" ? null : _jsx("span", { className: `h-1.5 w-1.5 rounded-full ${dot}` }), children] }));
}
export function ShortId({ id }) {
    return _jsx("span", { className: "mono text-step--1", title: id, children: id.length > 18 ? `${id.slice(0, 18)}…` : id });
}
/* --- Approvals --- */
/** What an approval is waiting for, in one word. */
export function approvalStateLabel(state) {
    if (state === "pending")
        return "Awaiting you";
    if (state === "expired")
        return "Expired";
    if (state === "approved" || state === "approved_forever")
        return "Approved";
    if (state === "denied")
        return "Rejected";
    return state;
}
/**
 * The state of an approval, from the server's rule: an undecided request
 * whose time is up is DEAD, not pending — deciding it would fail. It still
 * has to be visible, because a request nobody answered is exactly the kind
 * of silence that makes a workspace feel stuck.
 */
export function approvalState(approval) {
    if ((approval.decision ?? "pending") !== "pending")
        return "resolved";
    if (!approval.expires_at)
        return "pending";
    const expiry = new Date(approval.expires_at).getTime();
    if (Number.isNaN(expiry))
        return "pending";
    return expiry > Date.now() ? "pending" : "expired";
}
export function ApprovalStateBadge({ state }) {
    const variant = state === "pending"
        ? "warn"
        : state === "expired"
            ? "bad"
            : state === "approved" || state === "approved_forever"
                ? "ok"
                : state === "denied"
                    ? "neutral"
                    : "info";
    return _jsx(Badge, { variant: variant, children: approvalStateLabel(state) });
}
/** The three answers the owner can give, and nothing else.
 *
 *  "Forever" is a reusable permit for the same exact action; it is not a
 *  blanket permission, and the row that carries it says which action it is
 *  bound to. */
export function ApprovalDecisionButtons({ onDecide, busy, size = "md", }) {
    const label = size === "sm" ? "text-step--2" : "text-step--1";
    return (_jsxs("div", { className: "flex flex-wrap items-center gap-1.5", children: [_jsx(Button, { variant: "primary", disabled: busy, onClick: () => onDecide("approved"), className: label, children: "Approve once" }), _jsx(Button, { disabled: busy, onClick: () => onDecide("approved_forever"), className: label, children: "Forever" }), _jsx(Button, { variant: "danger", disabled: busy, onClick: () => onDecide("denied"), className: label, children: "Reject" })] }));
}
/**
 * One approval, and what the owner can do about it.
 *
 * The state is the point: a request whose time is up is DEAD, not pending, so
 * it says so and offers the way to ask again instead of a decision that
 * would fail.
 */
export function ApprovalRow({ approval, busy = false, onDecide, onReask, }) {
    const state = approvalState(approval);
    const askedBy = approval.teammate_persona || approval.requester || "the workspace";
    return (_jsx("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3", children: _jsxs("div", { className: "flex flex-wrap items-start justify-between gap-x-4 gap-y-2", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("strong", { className: "text-step-0 text-[var(--text)]", children: approval.action }), _jsx(ApprovalStateBadge, { state: state }), approval.tool_name ? (_jsx("span", { className: "text-step--2 text-[var(--faint)]", children: approval.performed ? "action performed" : "action not performed yet" })) : null] }), _jsxs("div", { className: "mt-1 text-step--1 text-[var(--muted)]", children: ["asked by ", askedBy, approval.task_description ? ` · ${approval.task_description}` : ""] }), approval.digest ? (_jsxs("div", { className: "mono mt-0.5 text-step--2 text-[var(--faint)]", children: ["digest ", approval.digest.slice(0, 16), "\u2026"] })) : null] }), _jsx("div", { className: "flex shrink-0 flex-col items-end gap-1.5", children: state === "pending" && onDecide ? (_jsx(ApprovalDecisionButtons, { onDecide: onDecide, busy: busy, size: "sm" })) : state === "expired" && onReask ? (_jsx(Button, { onClick: onReask, disabled: busy, children: "Ask again" })) : (_jsx("span", { className: "text-step--2 text-[var(--faint)]", children: approval.decided_at ? relativeTime(approval.decided_at) : "" })) })] }) }));
}
/* --- Shared table chrome --- */
/* One definition for the flat data-table treatment used by every evidence
 * surface (runs, boards, tasks). Views import these instead of re-declaring
 * near-identical string constants that drift apart over time. */
export const TABLE_SHELL = "overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]";
export const TABLE_TH = "border-b border-[var(--border)] px-3 py-2 text-left text-step--1 font-medium uppercase tracking-wide text-[var(--faint)]";
export const TABLE_TD = "border-b border-[var(--border-dim)] px-3 py-2.5 align-top";
/* --- Shared form + evidence chrome --- */
/** Full-width form field input (entity forms, inline modals). */
export const FORM_INPUT = "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
/** Compact input variant for dense inline forms. */
export const FORM_INPUT_SM = "rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
/** Mono evidence block (stdout, diffs, roll-up JSON). */
export const LOG_BLOCK = "mono mt-3 overflow-x-auto whitespace-pre rounded-lg bg-[var(--surface-2)] px-3 py-2 text-step--1 leading-relaxed text-[var(--text-soft)]";
/* --- Shared shell tokens --- */
/* One definition per recurring surface (the legacy compat layer, now
 * retired: views import these instead of re-declaring or re-applying). */
export const CARD_SHELL = "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm";
export const PILL_SHELL = "inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 text-step--2 font-medium text-[var(--text-soft)]";
export const CHIP_SHELL = "inline-flex items-center rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-step--2 text-[var(--text-soft)]";
export const ERROR_BOX = "rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step-0";
export const FORM_SELECT = "rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
/** Mono evidence block without margin (metrics JSON, backup results). */
export const LOG_SHELL = "mono overflow-x-auto whitespace-pre rounded-lg bg-[var(--surface-2)] px-3 py-2 text-step--1 leading-relaxed text-[var(--text-soft)]";
/* --- Shared task tally --- */
/** The one task-status tally: queued = pending | ready, plus running,
 *  blocked, done, failed, cancelled. Unknown statuses are ignored. Every
 *  aggregate surface (workspace summary, team rollups, per-team counts)
 *  derives its numbers through this so the status vocabulary cannot drift. */
export function taskTally(tasks) {
    let running = 0;
    let queued = 0;
    let blocked = 0;
    let done = 0;
    let failed = 0;
    let cancelled = 0;
    let awaiting = 0;
    for (const task of tasks) {
        if (task.status === "running")
            running += 1;
        else if (task.status === "awaiting_approval")
            awaiting += 1;
        else if (task.status === "blocked")
            blocked += 1;
        else if (task.status === "pending" || task.status === "ready")
            queued += 1;
        else if (task.status === "done")
            done += 1;
        else if (task.status === "failed")
            failed += 1;
        else if (task.status === "cancelled")
            cancelled += 1;
    }
    return { running, queued, blocked, done, failed, cancelled, awaiting };
}
export function useAsync(fn, deps = []) {
    const [nonce, setNonce] = useState(0);
    const key = JSON.stringify([nonce, ...deps]);
    const [snapshot, setSnapshot] = useState(null);
    useEffect(() => {
        let cancelled = false;
        fn().then((result) => {
            if (!cancelled) {
                setSnapshot({ key, data: result, error: null, loading: false });
            }
        }, (err) => {
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
        });
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
let cataloguePromise = null;
function loadCatalogue() {
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
export function usePermissionCatalogue() {
    const state = useAsync(() => loadCatalogue(), []);
    const permissions = state.data ?? [];
    const byName = new Map(permissions.map((p) => [p.name, p]));
    return {
        permissions,
        loading: state.loading,
        error: state.error,
        byName,
        isAdmin: (name) => byName.get(name)?.kind === "admin",
        denied: (held) => permissions.filter((p) => !held.includes(p.name)),
    };
}
