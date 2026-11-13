import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, ERROR_BOX, LOG_SHELL } from "../components";
export function BackupTab({ projectId }) {
    const [manifest, setManifest] = useState("");
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const download = async () => {
        setError(null);
        try {
            const data = await api.exportBackup(projectId);
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `nerdbot-backup-${projectId}.json`;
            link.click();
            URL.revokeObjectURL(url);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            notifyError(err);
        }
    };
    const runValidate = async () => {
        setError(null);
        setResult(null);
        try {
            const parsed = JSON.parse(manifest || "{}");
            setResult((await api.validateBackup(projectId, parsed)));
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            notifyError(err);
        }
    };
    const runImport = async (dryRun) => {
        setError(null);
        setResult(null);
        setBusy(true);
        try {
            const parsed = JSON.parse(manifest || "{}");
            setResult((await api.importBackup(projectId, parsed, dryRun)));
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("div", { children: [_jsx("div", { className: "flex items-center gap-3", style: { marginBottom: 12 }, children: _jsx(Button, { variant: "primary", onClick: () => void download(), children: "Export backup" }) }), _jsx("h2", { children: "Validate / import" }), _jsx("p", { className: "text-[var(--muted)]", children: "Paste a manifest, validate it, dry-run first, then apply." }), error ? _jsx("div", { className: ERROR_BOX, children: error }) : null, _jsxs("label", { className: "flex flex-col gap-1.5", children: [_jsx("span", { children: "Manifest JSON" }), _jsx("textarea", { rows: 6, value: manifest, onChange: (e) => setManifest(e.target.value), placeholder: '{"version": 1, \u2026}' })] }), _jsxs("div", { className: "flex items-center gap-3", style: { marginBottom: 12 }, children: [_jsx(Button, { onClick: () => void runValidate(), children: "Validate" }), _jsx(Button, { onClick: () => void runImport(true), disabled: busy, children: "Dry run" }), _jsx(Button, { variant: "danger", onClick: () => void runImport(false), disabled: busy, children: "Apply import" })] }), result ? _jsx("pre", { className: LOG_SHELL, children: JSON.stringify(result, null, 2) }) : null] }));
}
