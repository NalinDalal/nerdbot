import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, EmptyState, ErrorState, FORM_INPUT, FORM_SELECT, LoadingState, Modal, StatusBadge, TABLE_TD, TABLE_TH, useAsync, } from "../components";
export function SchedulesTab({ projectId }) {
    const list = useAsync(() => api.listSchedules(projectId), [projectId]);
    const presets = useAsync(() => api.schedulePresets(), []);
    const [showCreate, setShowCreate] = useState(false);
    const [edit, setEdit] = useState(null);
    const [historyFor, setHistoryFor] = useState(null);
    const act = async (fn) => {
        try {
            await fn();
            list.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    return (_jsxs("div", { children: [_jsxs("div", { className: "flex flex-wrap items-center gap-3", style: { marginBottom: 12 }, children: [_jsx(Button, { variant: "primary", onClick: () => setShowCreate(true), children: "New schedule" }), _jsx(Button, { onClick: list.reload, children: "Refresh" })] }), showCreate ? (_jsx(ScheduleModal, { title: "New schedule", presets: (presets.data?.presets || []), onClose: () => setShowCreate(false), onSubmit: async (body) => {
                    await api.createSchedule(projectId, body);
                    setShowCreate(false);
                    list.reload();
                } })) : null, edit ? (_jsx(ScheduleModal, { title: "Edit schedule", initial: edit, presets: (presets.data?.presets || []), onClose: () => setEdit(null), onSubmit: async (body) => {
                    await api.updateSchedule(edit.id, body);
                    setEdit(null);
                    list.reload();
                } })) : null, historyFor ? (_jsx(ScheduleHistoryModal, { schedule: historyFor, onClose: () => setHistoryFor(null) })) : null, list.loading ? (_jsx(LoadingState, {})) : list.error ? (_jsx(ErrorState, { error: list.error, onRetry: list.reload })) : list.data && list.data.schedules.length > 0 ? (_jsxs("table", { className: "w-full", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TABLE_TH, children: "Name" }), _jsx("th", { className: TABLE_TH, children: "Cron / TZ" }), _jsx("th", { className: TABLE_TH, children: "Next run" }), _jsx("th", { className: TABLE_TH, children: "Status" }), _jsx("th", { className: TABLE_TH, children: "Last result" }), _jsx("th", { className: TABLE_TH })] }) }), _jsx("tbody", { children: list.data.schedules.map((schedule) => (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsxs("td", { className: TABLE_TD, children: [_jsx("div", { className: "font-medium text-[var(--text)]", children: schedule.name || "Schedule" }), _jsx("div", { className: "text-step--2 text-[var(--faint)]", children: schedule.task_template?.description || "" })] }), _jsxs("td", { className: TABLE_TD, children: [_jsx("div", { className: "mono", children: schedule.cron }), _jsx("div", { className: "text-step--2 text-[var(--faint)]", children: schedule.timezone || "UTC" })] }), _jsx("td", { className: "mono text-[var(--muted)]", children: schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : "—" }), _jsx("td", { className: TABLE_TD, children: _jsxs("div", { className: "flex flex-wrap items-center gap-1.5", children: [_jsx(StatusBadge, { status: schedule.paused ? "paused" : schedule.enabled ? "scheduled" : "disabled" }), schedule.locked ? _jsx(StatusBadge, { status: "running", label: "firing" }) : null] }) }), _jsxs("td", { className: TABLE_TD, children: [_jsxs("div", { className: "text-step--2", children: [schedule.last_fired_at ? new Date(schedule.last_fired_at).toLocaleString() : "Never", schedule.fire_count ? ` · ${schedule.fire_count}×` : ""] }), schedule.last_error ? (_jsx("div", { className: "max-w-xs truncate text-step--2 text-[var(--danger)]", title: schedule.last_error, children: schedule.last_error })) : schedule.last_run_status ? (_jsx("div", { className: "text-step--2 text-[var(--muted)]", children: schedule.last_run_status })) : null] }), _jsx("td", { className: TABLE_TD, children: _jsxs("div", { className: "flex flex-wrap gap-1.5", children: [_jsx(Button, { onClick: () => void act(() => api.fireSchedule(schedule.id)), children: "Fire now" }), _jsx(Button, { onClick: () => setHistoryFor(schedule), children: "History" }), _jsx(Button, { onClick: () => setEdit(schedule), children: "Edit" }), schedule.paused ? (_jsx(Button, { onClick: () => void act(() => api.resumeSchedule(schedule.id)), children: "Resume" })) : (_jsx(Button, { onClick: () => void act(() => api.pauseSchedule(schedule.id)), children: "Pause" })), _jsx(Button, { variant: "danger", onClick: () => {
                                                    if (confirm(`Delete schedule "${schedule.name || schedule.id}"?`)) {
                                                        void act(() => api.deleteSchedule(schedule.id));
                                                    }
                                                }, children: "Delete" })] }) })] }, schedule.id))) })] })) : (_jsx(EmptyState, { title: "No schedules", hint: "Create a schedule to run work on a cron or preset." }))] }));
}
function ScheduleModal({ title, initial, presets, onClose, onSubmit, }) {
    const [name, setName] = useState(initial?.name || "");
    const [preset, setPreset] = useState("");
    const [cron, setCron] = useState(initial?.cron || "0 9 * * *");
    const [timezone, setTimezone] = useState(initial?.timezone || "UTC");
    const [description, setDescription] = useState(initial?.task_template?.description || "");
    const [command, setCommand] = useState(initial?.task_template?.command || "");
    const [teammateId, setTeammateId] = useState(initial?.teammate_id || initial?.task_template?.owner_teammate_id || "");
    const [busy, setBusy] = useState(false);
    return (_jsx(Modal, { title: title, onClose: onClose, children: _jsxs("form", { className: "flex flex-col gap-3", onSubmit: async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                    await onSubmit({
                        name,
                        cron,
                        timezone,
                        teammate_id: teammateId || undefined,
                        task_template: { description, command, ...(teammateId ? { owner_teammate_id: teammateId } : {}) },
                    });
                }
                catch (err) {
                    notifyError(err);
                }
                finally {
                    setBusy(false);
                }
            }, children: [_jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Name" }), _jsx("input", { className: FORM_INPUT, value: name, onChange: (e) => setName(e.target.value), required: true })] }), _jsxs("div", { className: "grid gap-3 sm:grid-cols-2", children: [_jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Preset" }), _jsxs("select", { className: FORM_SELECT, value: preset, onChange: (e) => {
                                        const v = e.target.value;
                                        setPreset(v);
                                        const p = presets.find((x) => x.id === v);
                                        if (p)
                                            setCron(p.cron);
                                    }, children: [_jsx("option", { value: "", children: "Custom cron" }), presets.map((p) => (_jsxs("option", { value: p.id, children: [p.label, " (", p.cron, ")"] }, p.id)))] })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Timezone" }), _jsx("input", { className: FORM_INPUT, value: timezone, onChange: (e) => setTimezone(e.target.value), placeholder: "UTC" })] })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Cron (5 fields)" }), _jsx("input", { className: `${FORM_INPUT} mono`, value: cron, onChange: (e) => setCron(e.target.value), required: true })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Task description" }), _jsx("input", { className: FORM_INPUT, value: description, onChange: (e) => setDescription(e.target.value), required: true })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Command (optional)" }), _jsx("input", { className: `${FORM_INPUT} mono`, value: command, onChange: (e) => setCommand(e.target.value), placeholder: "optional shell command" })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Teammate ID (optional)" }), _jsx("input", { className: `${FORM_INPUT} mono`, value: teammateId, onChange: (e) => setTeammateId(e.target.value), placeholder: "scope run to teammate" })] }), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx(Button, { type: "button", onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", disabled: busy, children: busy ? "Saving…" : "Save" })] })] }) }));
}
function ScheduleHistoryModal({ schedule, onClose }) {
    const runs = useAsync(() => api.listScheduleRuns(schedule.id, 50), [schedule.id]);
    return (_jsx(Modal, { title: `History: ${schedule.name || schedule.id}`, onClose: onClose, children: runs.loading ? _jsx(LoadingState, { lines: 4 }) : runs.error ? _jsx(ErrorState, { error: runs.error, onRetry: runs.reload }) : (_jsx("div", { className: "flex flex-col gap-2", children: (runs.data?.runs || []).length === 0 ? (_jsx("div", { className: "text-step--1 text-[var(--muted)]", children: "No runs recorded yet." })) : ((runs.data?.runs || []).map((r) => (_jsxs("div", { className: "rounded-lg border border-[var(--border-dim)] px-3 py-2 text-step--1", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx(StatusBadge, { status: r.status }), _jsx("span", { className: "mono text-step--2 text-[var(--faint)]", children: new Date(r.fired_at).toLocaleString() })] }), r.task_id ? _jsxs("div", { className: "mt-1 text-step--2 text-[var(--muted)]", children: ["task ", r.task_id, " \u00B7 run ", r.run_id || "—"] }) : null, r.error ? _jsx("div", { className: "mt-1 text-[var(--danger)]", children: r.error }) : null] }, r.id)))) })) }));
}
