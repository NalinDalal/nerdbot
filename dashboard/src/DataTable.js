import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { TABLE_SHELL, TABLE_TD, TABLE_TH } from "./components";
function cellText(row, key) {
    return String(row[key] ?? "");
}
export function DataTable({ columns, rows, onRowClick, loading, empty, error, stack }) {
    if (loading)
        return _jsx("div", { children: "Loading\u2026" });
    if (error)
        return _jsx("div", { children: error });
    if (!rows.length)
        return _jsx("div", { children: empty ?? "No data" });
    const table = (_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full table-fixed", children: [_jsx("thead", { children: _jsx("tr", { children: columns.map(c => _jsx("th", { className: TABLE_TH, children: c.header }, c.key)) }) }), _jsx("tbody", { children: rows.map((r, rowIndex) => {
                        /* The divider under the final row would double the shell's own
                           bottom border, so the last row's cells drop it explicitly
                           (`!border-b-0`, which out-specifies the border-b baked into
                           TABLE_TD). Composed per cell — a variant like `last:[&>td]`
                           compiles to `td:last-child` and strips the whole table's last
                           column instead. */
                        const isLastRow = rowIndex === rows.length - 1;
                        return (_jsx("tr", { onClick: () => onRowClick?.(r), className: "cursor-pointer transition-colors hover:bg-[var(--surface-2)]", children: columns.map(c => (_jsx("td", { className: `${TABLE_TD}${c.cellClass ? ` ${c.cellClass}` : ""}${isLastRow ? " !border-b-0" : ""}`, title: cellText(r, c.key), children: c.render ? c.render(r) : cellText(r, c.key) }, c.key))) }, r.id));
                    }) })] }) }));
    if (!stack)
        return table;
    const byKey = (key) => columns.find(c => c.key === key);
    const titleColumn = byKey(stack.title);
    const badgeColumn = stack.badge ? byKey(stack.badge) : undefined;
    const metaColumns = (stack.meta ?? [])
        .map(byKey)
        .filter((c) => Boolean(c));
    return (_jsxs("div", { children: [_jsx("div", { className: "max-sm:hidden", children: table }), _jsx("div", { className: "overflow-x-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] sm:hidden", children: rows.map((r, i) => (_jsxs("div", { onClick: () => onRowClick?.(r), className: `cursor-pointer min-w-0 px-3 py-3 transition-colors hover:bg-[var(--surface-2)] ${i > 0 ? "border-t border-[var(--border-dim)]" : ""}`, children: [titleColumn ? (_jsx("div", { className: "min-w-0", children: titleColumn.render ? titleColumn.render(r) : cellText(r, stack.title) })) : null, badgeColumn ? (_jsx("div", { className: "mt-2 min-w-0", children: badgeColumn.render ? badgeColumn.render(r) : cellText(r, stack.badge ?? "") })) : null, metaColumns.map(c => (_jsxs("div", { className: "mt-1 flex items-baseline gap-2 text-step--2 text-[var(--muted)]", children: [_jsx("span", { className: "shrink-0", children: c.header }), _jsx("span", { className: "min-w-0 break-words", children: c.render ? c.render(r) : cellText(r, c.key) })] }, c.key)))] }, r.id))) })] }));
}
