import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { BotAvatar } from "./BotAvatar";
import { COLOR_IDS, COLOR_LABELS, EXPRESSION_IDS, EXPRESSION_LABELS, SHAPE_IDS, SHAPE_LABELS, randomFace, } from "./face";
import { COLOR_BY_ID } from "./skins";
export function FacePicker({ value, onChange, compact = false }) {
    const preview = compact ? 88 : 128;
    const tile = compact ? 40 : 48;
    return (_jsxs("div", { className: "flex flex-col gap-5", children: [_jsxs("div", { className: "flex items-center gap-5", children: [_jsx("div", { className: "shrink-0", children: _jsx(BotAvatar, { face: value, size: preview, animated: true, label: `Preview of the selected face: ${SHAPE_LABELS[value.shape]}, ${COLOR_LABELS[value.color]}, ${EXPRESSION_LABELS[value.expression]}` }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("dl", { className: "text-step--1", children: [
                                    ["Body", SHAPE_LABELS[value.shape]],
                                    ["Colour", COLOR_LABELS[value.color]],
                                    ["Expression", EXPRESSION_LABELS[value.expression]],
                                ].map(([key, text]) => (_jsxs("div", { className: "flex items-baseline justify-between gap-4 border-b border-[var(--border-dim)] py-1 last:border-0", children: [_jsx("dt", { className: "text-[var(--faint)]", children: key }), _jsx("dd", { className: "truncate text-[var(--text-soft)]", children: text })] }, key))) }), _jsx("div", { className: "mt-2 flex justify-end", children: _jsxs("button", { type: "button", onClick: () => onChange(randomFace(Math.random, value)), className: "inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1 text-step--1 text-[var(--text-soft)] transition-colors hover:border-[var(--border-focus)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]", children: [_jsx("span", { "aria-hidden": "true", className: "text-[var(--accent)]", children: "\u2726" }), "Surprise me"] }) })] })] }), _jsxs("fieldset", { children: [_jsx("legend", { className: "mb-2 text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)]", children: "Body" }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: SHAPE_IDS.map((shape) => {
                            const selected = value.shape === shape;
                            return (_jsx("button", { type: "button", "aria-pressed": selected, title: SHAPE_LABELS[shape], "aria-label": `Body: ${SHAPE_LABELS[shape]}`, onClick: () => onChange({ ...value, shape }), className: `overflow-hidden rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${selected
                                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                                    : "border-[var(--border)] hover:border-[var(--border-focus)]"}`, children: _jsx(BotAvatar, { face: { ...value, shape }, size: tile, label: `${SHAPE_LABELS[shape]} body` }) }, shape));
                        }) })] }), _jsxs("fieldset", { children: [_jsx("legend", { className: "mb-2 text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)]", children: "Colour" }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: COLOR_IDS.map((color) => {
                            const selected = value.color === color;
                            const hex = COLOR_BY_ID.get(color)?.hex ?? "#0a0a0c";
                            return (_jsx("button", { type: "button", "aria-pressed": selected, title: COLOR_LABELS[color], "aria-label": `Colour: ${COLOR_LABELS[color]}`, onClick: () => onChange({ ...value, color }), className: `h-7 w-7 rounded-full border-2 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] ${selected
                                    ? "border-[var(--accent)] scale-110"
                                    : "border-[var(--border)] hover:scale-105"}`, style: { background: hex } }, color));
                        }) })] }), _jsxs("fieldset", { children: [_jsx("legend", { className: "mb-2 text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)]", children: "Expression" }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: EXPRESSION_IDS.map((expression) => {
                            const selected = value.expression === expression;
                            return (_jsx("button", { type: "button", "aria-pressed": selected, title: EXPRESSION_LABELS[expression], "aria-label": `Expression: ${EXPRESSION_LABELS[expression]}`, onClick: () => onChange({ ...value, expression }), className: `overflow-hidden rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${selected
                                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                                    : "border-[var(--border)] hover:border-[var(--border-focus)]"}`, children: _jsx(BotAvatar, { face: { ...value, expression }, size: tile, label: `${EXPRESSION_LABELS[expression]} expression` }) }, expression));
                        }) })] })] }));
}
