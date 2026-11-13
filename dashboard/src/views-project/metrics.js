import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { api } from "../api";
import { Button, EmptyState, ErrorState, LOG_SHELL, LoadingState, useAsync } from "../components";
export function MetricsTab({ projectId }) {
    const metrics = useAsync(() => api.projectMetrics(projectId), [projectId]);
    return (_jsxs("div", { children: [_jsx("div", { className: "flex items-center gap-3", style: { marginBottom: 12 }, children: _jsx(Button, { onClick: metrics.reload, children: "Refresh" }) }), metrics.loading ? (_jsx(LoadingState, {})) : metrics.error ? (_jsx(ErrorState, { error: metrics.error, onRetry: metrics.reload })) : metrics.data ? (_jsx("pre", { className: LOG_SHELL, children: JSON.stringify(metrics.data, null, 2) })) : (_jsx(EmptyState, { title: "No metrics" }))] }));
}
