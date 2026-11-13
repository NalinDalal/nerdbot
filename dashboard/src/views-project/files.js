import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** The workspace's files, across every task checkout.
 *
 *  Each task runs in its own isolated checkout. This tab is the workspace
 *  view of them: what was produced, by which task, on which branch.
 */
import { api } from "../api";
import { EmptyState, ErrorState, LoadingState, ShortId, StatStrip, TABLE_SHELL, TABLE_TD, TABLE_TH, useAsync, } from "../components";
export function FilesTab({ projectId }) {
    const list = useAsync(() => api.projectWorkspaceFiles(projectId), [projectId]);
    const checkouts = list.data?.checkouts ?? [];
    return (_jsx("div", { children: list.loading ? (_jsx(LoadingState, { lines: 3 })) : list.error ? (_jsx(ErrorState, { error: list.error, onRetry: list.reload })) : checkouts.length === 0 ? (_jsx(EmptyState, { title: "No files yet", hint: "A task writes into its own isolated checkout. Run a task, or press Ensure workspace on one, and its files appear here." })) : (_jsxs(_Fragment, { children: [_jsx(StatStrip, { className: "mb-4", items: [
                        { label: "checkouts", value: checkouts.length },
                        { label: "files", value: list.data?.file_count ?? 0 },
                    ] }), checkouts.map((checkout) => (_jsxs("div", { className: "mb-6 last:mb-0", children: [_jsxs("div", { className: "mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5", children: [_jsx("a", { href: `/p/${projectId}/t/${checkout.task_id}`, className: "text-step-0 font-medium text-[var(--text)] hover:underline", children: checkout.task_description || "Untitled task" }), _jsxs("span", { className: "mono text-step--2 text-[var(--faint)]", children: [_jsx(ShortId, { id: checkout.task_id }), checkout.branch ? ` · ${checkout.branch}` : ""] })] }), _jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full table-fixed", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TABLE_TH, children: "File" }), _jsx("th", { className: `${TABLE_TH} w-[8rem]`, children: "Size" })] }) }), _jsx("tbody", { children: checkout.files.map((file) => (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsx("td", { className: TABLE_TD, children: _jsx("span", { className: "mono block truncate text-step--1 text-[var(--text-soft)]", title: file.path, children: file.path }) }), _jsx("td", { className: TABLE_TD, children: _jsxs("span", { className: "text-step--1 text-[var(--muted)]", children: [file.size, " B"] }) })] }, file.path))) })] }) })] }, checkout.task_id)))] })) }));
}
