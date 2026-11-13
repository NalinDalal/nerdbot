import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable } from "./DataTable";
import { TABLE_TD } from "./components";
const rows = [{ id: "r1", n: "Alpha" }, { id: "r2", n: "Beta" }];
const tdCells = (html) => html.match(/<td\b[^>]*>/g) ?? [];
describe("DataTable", () => {
    it("applies TABLE_TD to every rendered cell", () => {
        const html = renderToStaticMarkup(h((DataTable), { columns: [{ key: "n", header: "N" }], rows }));
        const cells = tdCells(html);
        expect(cells).toHaveLength(rows.length);
        for (const cell of cells)
            expect(cell).toContain(TABLE_TD);
    });
    it("a column's cellClass layers on without replacing TABLE_TD", () => {
        const columns = [{ key: "n", header: "N", render: (r) => r.n, cellClass: "mono" }];
        const html = renderToStaticMarkup(h((DataTable), { columns, rows }));
        const cells = tdCells(html);
        for (const cell of cells) {
            expect(cell).toContain(TABLE_TD);
            expect(cell).toContain("mono");
        }
    });
    it("the last row's cells carry TABLE_TD too, with its divider cut", () => {
        const html = renderToStaticMarkup(h((DataTable), { columns: [{ key: "n", header: "N" }], rows }));
        const cells = tdCells(html);
        expect(cells[0]).not.toContain("!border-b-0");
        expect(cells[cells.length - 1]).toContain("!border-b-0");
        expect(cells[cells.length - 1]).toContain(TABLE_TD);
    });
});
