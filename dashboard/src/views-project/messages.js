import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, EmptyState, ErrorState, FORM_SELECT, LoadingState, PILL_SHELL, TABLE_TD, TABLE_TH, useAsync } from "../components";
import { Markdown } from "../markdown";
export function MessagesTab({ projectId }) {
    const [scope, setScope] = useState("");
    const msgs = useAsync(() => api.projectMessages(projectId, scope || undefined), [projectId, scope]);
    const mates = useAsync(() => api.listTeammates(projectId), [projectId]);
    useEffect(() => {
        // Poll the response channel while the tab is open.
        const t = setInterval(msgs.reload, 5000);
        return () => clearInterval(t);
    }, [msgs.reload]);
    const nameOf = (id) => {
        if (!id)
            return "—";
        return mates.data?.teammates.find((m) => m.id === id)?.persona || id.slice(0, 10);
    };
    const rows = msgs.data?.messages ?? [];
    return (_jsxs("section", { children: [_jsxs("div", { className: "flex items-center gap-3", style: { marginBottom: 12 }, children: [_jsxs("select", { className: FORM_SELECT, value: scope, onChange: (e) => setScope(e.target.value), "aria-label": "Filter by recipient", children: [_jsx("option", { value: "", children: "All recipients" }), (mates.data?.teammates ?? []).map((m) => (_jsxs("option", { value: m.id, children: ["To: ", m.persona] }, m.id)))] }), _jsx(Button, { onClick: msgs.reload, children: "Refresh" })] }), msgs.loading && !msgs.data ? (_jsx(LoadingState, {})) : msgs.error ? (_jsx(ErrorState, { error: msgs.error, onRetry: msgs.reload })) : rows.length === 0 ? (_jsx(EmptyState, { title: "No messages yet", hint: "Bot-to-bot responses and board messages appear here." })) : (_jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TABLE_TH, children: "Kind" }), _jsx("th", { className: TABLE_TH, children: "From" }), _jsx("th", { className: TABLE_TH, children: "To" }), _jsx("th", { className: TABLE_TH, children: "Board" }), _jsx("th", { className: TABLE_TH, children: "Content" }), _jsx("th", { className: TABLE_TH, children: "When" })] }) }), _jsx("tbody", { children: rows.map((m) => (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsx("td", { className: TABLE_TD, children: _jsx("span", { className: PILL_SHELL, children: m.kind }) }), _jsx("td", { className: TABLE_TD, children: nameOf(m.from_teammate_id) }), _jsx("td", { className: TABLE_TD, children: m.to_teammate_id ? nameOf(m.to_teammate_id) : "everyone" }), _jsx("td", { className: TABLE_TD, children: m.board_name || "—" }), _jsx("td", { style: { maxWidth: 420, wordBreak: "break-word" }, children: _jsx(Markdown, { text: m.content }) }), _jsx("td", { className: "text-[var(--muted)]", children: new Date(m.created_at).toLocaleString() })] }, m.id))) })] }) }))] }));
}
