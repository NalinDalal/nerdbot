import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, CARD_SHELL, EmptyState, ErrorState, LoadingState, Modal, ShortId, StatusBadge, TABLE_TD, TABLE_TH, useAsync } from "../components";
import { EntityForm } from "../forms";
export function NotificationsTab({ projectId }) {
    const list = useAsync(() => api.listNotifications(projectId), [projectId]);
    const [showSend, setShowSend] = useState(false);
    const [showTarget, setShowTarget] = useState(false);
    const targets = useAsync(() => api.listWebhookTargets(projectId), [projectId]);
    const act = async (fn) => {
        try {
            await fn();
            list.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    return (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-3", style: { marginBottom: 12 }, children: [_jsx(Button, { variant: "primary", onClick: () => setShowSend(true), children: "Send notification" }), _jsx(Button, { onClick: () => setShowTarget(true), children: "Add webhook target" }), _jsx(Button, { onClick: () => act(() => api.sweepWebhooks()), children: "Sweep due webhooks" }), _jsx(Button, { onClick: list.reload, children: "Refresh" })] }), _jsx("p", { className: "text-[var(--muted)]", style: { fontSize: 12, marginTop: 0, marginBottom: 12 }, children: "Deliveries run only when swept here or by OS cron (nerdbot deliveries-sweep). There is no background delivery recovery in NerdBot." }), showSend ? (_jsx(Modal, { title: "Send notification", onClose: () => setShowSend(false), children: _jsx(EntityForm, { submitLabel: "Send", fields: [
                        { name: "channel", label: "Channel", type: "select", options: ["outbox", "webhook-out"] },
                        { name: "kind", label: "Kind", required: true, placeholder: "deploy.done" },
                        { name: "payload", label: "Payload (JSON object)", placeholder: '{"ref": "main"}' },
                        { name: "target_url", label: "Target URL override (webhook-out only)" },
                    ], onSubmit: async (values) => {
                        let payload = {};
                        try {
                            payload = values.payload ? JSON.parse(values.payload) : {};
                        }
                        catch {
                            throw new Error("Payload is not valid JSON");
                        }
                        await api.sendNotification(projectId, { ...values, payload });
                        setShowSend(false);
                        list.reload();
                    } }) })) : null, showTarget ? (_jsx(Modal, { title: "Add webhook target", onClose: () => setShowTarget(false), children: _jsx(EntityForm, { submitLabel: "Add target", fields: [{ name: "url", label: "HTTPS URL (public hosts only)", required: true }], onSubmit: async (values) => {
                        await api.addWebhookTarget(projectId, values.url);
                        setShowTarget(false);
                        targets.reload();
                    } }) })) : null, targets.data && targets.data.targets.length > 0 ? (_jsxs("div", { className: CARD_SHELL, children: [_jsx("strong", { children: "Targets" }), targets.data.targets.map((target) => (_jsxs("div", { className: "flex items-center gap-3 mono text-[var(--muted)]", style: { justifyContent: "space-between" }, children: [_jsx("span", { children: String(target.url) }), _jsx(Button, { onClick: () => act(async () => {
                                    await api.deleteWebhookTarget(String(target.id));
                                    targets.reload();
                                }), children: "Remove" })] }, String(target.id))))] })) : null, list.loading ? (_jsx(LoadingState, {})) : list.error ? (_jsx(ErrorState, { error: list.error, onRetry: list.reload })) : list.data && list.data.notifications.length > 0 ? (_jsxs("table", { className: "w-full", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TABLE_TH, children: "ID" }), _jsx("th", { className: TABLE_TH, children: "Channel" }), _jsx("th", { className: TABLE_TH, children: "Kind" }), _jsx("th", { className: TABLE_TH, children: "Status" }), _jsx("th", { className: TABLE_TH, children: "Attempts" }), _jsx("th", { className: TABLE_TH, children: "Next attempt" }), _jsx("th", { className: TABLE_TH, children: "Last error" }), _jsx("th", { className: TABLE_TH })] }) }), _jsx("tbody", { children: list.data.notifications.map((note) => (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsx("td", { className: TABLE_TD, children: _jsx(ShortId, { id: note.id }) }), _jsx("td", { className: "text-[var(--muted)]", children: note.channel }), _jsx("td", { className: TABLE_TD, children: note.kind }), _jsx("td", { className: TABLE_TD, children: _jsxs("div", { className: "flex items-center gap-3", style: { gap: 6 }, children: [_jsx(StatusBadge, { status: note.status }), note.locked ? (_jsx("span", { className: "inline-flex items-center rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-step--2 font-medium text-[var(--muted)]", children: "locked" })) : null] }) }), _jsx("td", { className: `${TABLE_TD} mono`, children: note.attempts }), _jsx("td", { className: "mono text-[var(--muted)]", children: note.next_attempt_at ?? "" }), _jsx("td", { className: "mono text-[var(--muted)]", style: { maxWidth: 320, overflowWrap: "anywhere" }, title: note.last_error || undefined, children: note.last_error }), _jsx("td", { className: TABLE_TD, children: _jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Button, { onClick: () => act(() => api.deliverNotification(note.id)), children: "Deliver" }), _jsx(Button, { onClick: () => act(() => api.unlockNotification(note.id)), children: "Unlock" })] }) })] }, note.id))) })] })) : (_jsx(EmptyState, { title: "No notifications", hint: "Send one to record or deliver it." }))] }));
}
