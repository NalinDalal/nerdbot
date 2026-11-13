import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "./api";
import { notifyError } from "./app";
import { Button, ERROR_BOX, Field } from "./components";
const CONTROL_CLASS = "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step-0 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";
/** Small controlled form over a flat string map. One required rule per
 *  field, inline errors, and an honest inline failure box — deliberately
 *  plain React instead of a form library, which cost more bundle than it
 *  bought for a form this simple. */
export function EntityForm({ fields, submitLabel, onSubmit, }) {
    const [values, setValues] = useState(() => Object.fromEntries(fields.map((field) => [field.name, ""])));
    const [errors, setErrors] = useState({});
    const [failed, setFailed] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const set = (name) => (event) => setValues((prev) => ({ ...prev, [name]: event.target.value }));
    const submit = async (event) => {
        event.preventDefault();
        const next = {};
        for (const field of fields) {
            if (field.required && !(values[field.name] ?? "").trim()) {
                next[field.name] = `${field.label} is required`;
            }
        }
        setErrors(next);
        if (Object.keys(next).length > 0)
            return;
        setFailed(null);
        setSubmitting(true);
        try {
            await onSubmit(values);
            toast.success("Saved");
        }
        catch (err) {
            const message = describeError(err);
            setFailed(message);
            notifyError(err);
        }
        finally {
            setSubmitting(false);
        }
    };
    return (_jsxs("form", { onSubmit: submit, children: [failed ? (_jsx("div", { className: ERROR_BOX, role: "alert", children: failed })) : null, fields.map((field) => (_jsxs(Field, { label: field.label, error: errors[field.name], children: [field.type === "textarea" ? (_jsx("textarea", { rows: 3, placeholder: field.placeholder, className: `${CONTROL_CLASS} resize-y`, value: values[field.name] ?? "", onChange: set(field.name) })) : field.type === "select" ? (_jsx("select", { className: CONTROL_CLASS, value: values[field.name] ?? "", onChange: set(field.name), children: (field.options ?? []).map((option) => (_jsx("option", { value: option, children: option }, option))) })) : (_jsx("input", { type: field.type === "password" ? "password" : "text", placeholder: field.placeholder, autoComplete: "off", className: CONTROL_CLASS, value: values[field.name] ?? "", onChange: set(field.name) })), field.hint ? (_jsx("div", { className: "text-step--1 text-[var(--faint)]", children: field.hint })) : null] }, field.name))), _jsx(Button, { variant: "primary", type: "submit", disabled: submitting, className: "mt-2", children: submitting ? "Saving…" : submitLabel })] }));
}
