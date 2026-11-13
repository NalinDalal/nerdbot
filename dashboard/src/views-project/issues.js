import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, CARD_SHELL, ERROR_BOX, EmptyState, ErrorState, LoadingState, Modal, StatusBadge, useAsync } from "../components";
import { EntityForm } from "../forms";
export function IssuesTab({ projectId }) {
    const list = useAsync(() => api.listIssues(projectId), [projectId]);
    const [showCreate, setShowCreate] = useState(false);
    const [showGithub, setShowGithub] = useState(false);
    return (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-3", style: { marginBottom: 12 }, children: [_jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "New issue" }), _jsx(Button, { onClick: () => setShowGithub(true), children: "Fetch from GitHub" }), _jsx(Button, { onClick: list.reload, children: "Refresh" })] }), showCreate ? (_jsx(Modal, { title: "New issue", onClose: () => setShowCreate(false), children: _jsx(EntityForm, { submitLabel: "Create issue", fields: [
                        { name: "title", label: "Title", required: true },
                        { name: "body", label: "Body", type: "textarea" },
                        { name: "acceptance_criteria", label: "Acceptance criteria (comma separated)" },
                        { name: "priority", label: "Priority", type: "select", options: ["low", "medium", "high"] },
                    ], onSubmit: async (values) => {
                        await api.createIssue(projectId, {
                            ...values,
                            acceptance_criteria: values.acceptance_criteria.split(",").map((s) => s.trim()).filter(Boolean),
                        });
                        setShowCreate(false);
                        list.reload();
                    } }) })) : null, showGithub ? (_jsx(Modal, { title: "Preview GitHub issue", onClose: () => setShowGithub(false), children: _jsx(GithubPreview, { projectId: projectId, onIngested: list.reload }) })) : null, list.loading ? (_jsx(LoadingState, {})) : list.error ? (_jsx(ErrorState, { error: list.error, onRetry: list.reload })) : list.data && list.data.issues.length > 0 ? (list.data.issues.map((issue) => (_jsxs("div", { className: CARD_SHELL, children: [_jsxs("div", { className: "flex items-center gap-3", style: { justifyContent: "space-between" }, children: [_jsx("strong", { children: issue.title }), _jsx(StatusBadge, { status: issue.status })] }), _jsxs("div", { className: "mono text-[var(--muted)]", children: [issue.id, " \u00B7 ", issue.source, issue.external_id ? ` · ${issue.external_id}` : ""] }), issue.body ? _jsx("div", { style: { marginTop: 8 }, children: issue.body }) : null] }, issue.id)))) : (_jsx(EmptyState, { title: "No issues", hint: "Ingest one manually or preview from GitHub." }))] }));
}
function GithubPreview({ projectId, onIngested }) {
    const [repository, setRepository] = useState("");
    const [number, setNumber] = useState("");
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const fetchPreview = async () => {
        setError(null);
        setBusy(true);
        try {
            const data = await api.previewGithubIssue(projectId, repository.trim(), Number(number));
            setPreview(data);
        }
        catch (err) {
            notifyError(err);
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setBusy(false);
        }
    };
    const ingest = async () => {
        if (!preview)
            return;
        const suggested = preview.suggested_ingest;
        try {
            await api.createIssue(projectId, suggested);
            onIngested();
            setPreview(null);
        }
        catch (err) {
            notifyError(err);
        }
    };
    return (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("input", { value: repository, onChange: (e) => setRepository(e.target.value), placeholder: "owner/repo", "aria-label": "Repository" }), _jsx("input", { value: number, onChange: (e) => setNumber(e.target.value), placeholder: "7", "aria-label": "Issue number", style: { maxWidth: 100 } }), _jsx(Button, { variant: "primary", onClick: fetchPreview, disabled: busy, children: busy ? "Fetching…" : "Preview" })] }), error ? _jsx("div", { className: ERROR_BOX, style: { marginTop: 12 }, children: error }) : null, preview ? (_jsxs("div", { className: CARD_SHELL, style: { marginTop: 12 }, children: [_jsx("div", { className: "text-[var(--muted)]", style: { fontSize: 12 }, children: "Untrusted preview. Confirm before ingesting." }), _jsx("strong", { children: String(preview.title ?? "") }), _jsx("div", { className: "text-[var(--muted)]", children: String(preview.body ?? "").slice(0, 400) }), _jsx("div", { style: { marginTop: 12 }, children: _jsx(Button, { variant: "primary", onClick: ingest, children: "Confirm and ingest" }) })] })) : null] }));
}
