import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { api } from "./api";
import { BotFace } from "./components";
export function deriveMemberState(member) {
    if (member?.current?.status === "running")
        return "working";
    if ((member?.failed || 0) > 0)
        return "failed";
    if (member?.current?.status === "pending")
        return "waiting_approval";
    return "idle";
}
export function TeamView({ objectiveId, onOpenTask }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [providers, setProviders] = useState([]);
    useEffect(() => {
        if (!objectiveId)
            return;
        let alive = true;
        const load = async () => {
            try {
                const d = await api.teamActivity?.(objectiveId);
                if (alive) {
                    setData(d);
                    if (d?.project_id) {
                        try {
                            const pr = await api.listProviders(d.project_id);
                            setProviders(pr.providers?.flatMap((p) => p.models ? [{ id: p.id, name: p.name }] : [{ id: p.id, name: p.name }]) || []);
                        }
                        catch { }
                    }
                }
            }
            catch (e) {
                if (alive)
                    setError(e?.message || "failed to load");
            }
        };
        load();
        const t = setInterval(load, 5000);
        return () => { alive = false; clearInterval(t); };
    }, [objectiveId]);
    if (!objectiveId)
        return null;
    if (error)
        return _jsx("div", { className: "text-step--1 text-[var(--danger)]", children: error });
    if (!data)
        return _jsx("div", { className: "text-step--1 text-[var(--muted)]", children: "Loading team\u2026" });
    const obj = data.objective || {};
    return (_jsxs("div", { className: "flex flex-col gap-3", children: [_jsxs("div", { children: [_jsx("div", { className: "text-step-0 font-semibold text-[var(--text)]", children: obj.title || "Objective" }), _jsxs("div", { className: "text-step--2 text-[var(--muted)]", children: [obj.done ?? 0, " of ", obj.total ?? 0, " done \u00B7 ", obj.status] })] }), (data.members || []).some((m) => !m.teammate?.provider_id) ? (_jsxs("div", { className: "rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-2.5 py-2 text-step--2 text-[var(--warn)]", children: ["Some teammates have no model configured.", providers.length > 0 ? (_jsxs("button", { type: "button", className: "ml-2 underline", onClick: async () => {
                            try {
                                await api.attachProviderAll?.(data.project_id, { provider_id: providers[0].id });
                                const d = await api.teamActivity?.(objectiveId);
                                setData(d);
                            }
                            catch (e) {
                                alert(e?.message || "failed");
                            }
                        }, children: ["Use ", providers[0].name, " for all"] })) : (_jsx("span", { className: "ml-2", children: "Configure in Settings." }))] })) : null, (data.members || []).map((m, i) => {
                const state = deriveMemberState(m);
                return (_jsxs("div", { className: "rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(BotFace, { face: m.teammate?.face, size: 24 }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-step--1 text-[var(--text)]", children: m.teammate?.name || m.teammate?.slug }), _jsxs("div", { className: "truncate text-step--2 text-[var(--muted)]", children: [state === "idle" && "Idle", state === "working" && (m.current?.title || "Working…"), state === "waiting_approval" && "Waiting for approval", state === "failed" && "Failed"] })] })] }), m.current?.task_id ? (_jsx("button", { type: "button", className: "mt-1 text-step--2 text-[var(--accent)] hover:underline", onClick: () => onOpenTask?.("", m.current.task_id), children: "Open task \u2192" })) : null] }, i));
            }), (data.failures || []).length > 0 ? (_jsxs("div", { className: "flex flex-col gap-1.5", children: [_jsx("div", { className: "text-step--2 font-medium uppercase tracking-wider text-[var(--danger)]", children: "Failures" }), data.failures.map((f, i) => (_jsxs("div", { className: "rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-2.5 py-2 text-step--1 text-[var(--danger)]", children: [f.title || f.task_id, ": ", f.reason_text] }, i)))] })) : null] }));
}
