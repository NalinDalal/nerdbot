import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, CARD_SHELL, EmptyState, ErrorState, LoadingState, PILL_SHELL, ShortId, StatusBadge, TABLE_TD, TABLE_TH, approvalIsPending, useAsync } from "../components";
export function ApprovalsTab({ projectId }) {
    // Merge project-wide approvals with per-run ones: legacy rows may have an
    // empty project_id, so the project query alone can miss them.
    const inbox = useAsync(async () => {
        const byId = new Map();
        const projectRows = (await api.projectApprovals(projectId)).approvals;
        for (const approval of projectRows)
            byId.set(approval.id, approval);
        const runList = (await api.projectRuns(projectId)).runs;
        for (const run of runList) {
            const list = await api.listRunApprovals(run.id);
            for (const approval of list.approvals) {
                if (!byId.has(approval.id))
                    byId.set(approval.id, approval);
            }
        }
        return [...byId.values()];
    }, [projectId]);
    // Poll while anything awaits a decision so bot requests show up unprompted.
    // Only genuinely actionable approvals count: an expired one can never be
    // decided, so polling for it would spin forever.
    useEffect(() => {
        const pendingCount = (inbox.data ?? []).filter((a) => approvalIsPending(a)).length;
        if (!pendingCount)
            return;
        const t = setInterval(inbox.reload, 8000);
        return () => clearInterval(t);
    }, [inbox.data, inbox.reload]);
    const decide = async (id, decision) => {
        try {
            await api.decideApproval(id, decision);
            inbox.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    const rows = inbox.data ?? [];
    // Actionable: still pending and not past its expiry.
    const pending = rows.filter((approval) => approvalIsPending(approval));
    // Dead: never decided and past its expiry. The API answers 410 for these,
    // so they are shown as history, never as a decision to make.
    const expired = rows.filter((approval) => !approvalIsPending(approval) && (approval.decision ?? "pending") === "pending");
    const expiredIds = new Set(expired.map((approval) => approval.id));
    const decided = rows.filter((approval) => (approval.decision ?? "pending") !== "pending");
    const history = [...decided, ...expired];
    return (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-3", style: { marginBottom: 12 }, children: [_jsx(Button, { onClick: async () => {
                            try {
                                await api.purgeApprovals(projectId);
                                inbox.reload();
                            }
                            catch (err) {
                                notifyError(err);
                            }
                        }, children: "Purge expired" }), _jsx(Button, { onClick: inbox.reload, children: "Refresh" })] }), inbox.loading && !inbox.data ? (_jsx(LoadingState, {})) : inbox.error ? (_jsx(ErrorState, { error: inbox.error, onRetry: inbox.reload })) : pending.length > 0 ? (pending.map((approval) => (_jsx("div", { className: CARD_SHELL, children: _jsxs("div", { className: "flex items-center gap-3", style: { justifyContent: "space-between" }, children: [_jsxs("div", { children: [_jsx("strong", { children: approval.action || "approval" }), " ", _jsx("span", { className: "mono text-[var(--muted)]", children: approval.id }), " ", _jsx("span", { className: PILL_SHELL, children: approval.requester }), " ", approval.task_id ? (_jsxs("a", { href: `/p/${projectId}/t/${approval.task_id}`, children: ["task ", _jsx(ShortId, { id: approval.task_id })] })) : null, _jsxs("div", { className: "mono text-[var(--muted)]", style: { fontSize: 12 }, children: ["digest: ", approval.digest || "—"] })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Button, { variant: "primary", onClick: () => void decide(approval.id, "approved"), children: "Approve" }), _jsx(Button, { variant: "primary", onClick: () => void decide(approval.id, "approved_forever"), children: "Approve Forever" }), _jsx(Button, { variant: "danger", onClick: () => void decide(approval.id, "denied"), children: "Deny" })] })] }) }, approval.id)))) : (_jsx(EmptyState, { title: "Inbox empty", hint: "No pending approvals. Decided ones stay queryable per run." })), history.length > 0 ? (_jsxs(_Fragment, { children: [_jsx("h2", { children: "Decision history" }), _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TABLE_TH, children: "ID" }), _jsx("th", { className: TABLE_TH, children: "Action" }), _jsx("th", { className: TABLE_TH, children: "Requester" }), _jsx("th", { className: TABLE_TH, children: "Decision" }), _jsx("th", { className: TABLE_TH, children: "Executed" })] }) }), _jsx("tbody", { children: history.map((approval) => (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsx("td", { className: TABLE_TD, children: _jsx(ShortId, { id: approval.id }) }), _jsx("td", { className: TABLE_TD, children: approval.action }), _jsx("td", { className: TABLE_TD, children: approval.requester }), _jsx("td", { className: TABLE_TD, children: _jsx(StatusBadge, { status: expiredIds.has(approval.id) ? "expired" : approval.decision }) }), _jsx("td", { className: "text-[var(--muted)]", children: approval.executed_at ? new Date(approval.executed_at).toLocaleString() : "—" })] }, approval.id))) })] }) })] })) : null] }));
}
