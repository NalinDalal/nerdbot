import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { FORM_INPUT } from "./components";
/**
 * A searchable picker over one entity kind (teammates, issues, ...).
 *
 * A select the owner can narrow by typing — raw id inputs sent people
 * hunting through another tab for a `tm_...` string before every submit.
 * Passing an empty option lets the owner leave the choice unmade: owner
 * and issue are optional facts about a task.
 */
export function EntityPicker({ items, value, onChange, placeholder, }) {
    const [q, setQ] = useState("");
    const query = q.trim().toLowerCase();
    const filtered = items.filter((item) => item.name.toLowerCase().includes(query));
    return (_jsxs("div", { className: "flex flex-col items-stretch gap-1.5 sm:flex-row", children: [_jsx("input", { value: q, onChange: (e) => setQ(e.target.value), placeholder: placeholder ?? "Search", "aria-label": placeholder ?? "Search", className: `${FORM_INPUT} sm:max-w-[12rem]` }), _jsxs("select", { value: value, onChange: (e) => onChange(e.target.value), className: FORM_INPUT, "aria-label": "Selected entity", children: [_jsx("option", { value: "", children: "\u2014" }), filtered.map((item) => (_jsx("option", { value: item.id, children: item.name }, item.id)))] })] }));
}
