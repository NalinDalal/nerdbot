import { TABLE_SHELL, TABLE_TD, TABLE_TH } from "./components";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  /**
   * Extra classes for this column's cells. TABLE_TD is always applied by
   * the table itself and never replaceable, so a view layering mono text
   * or a narrower max-width onto one column cannot forget the shared
   * chrome (padding, align-top, the row divider).
   */
  cellClass?: string;
}

export function DataTable<T extends { id: string }>({ columns, rows, onRowClick, loading, empty, error }: {
  columns: Column<T>[]; rows: T[]; onRowClick?: (row: T) => void;
  loading?: boolean; empty?: string; error?: string;
}) {
  if (loading) return <div>Loading…</div>;
  if (error) return <div>{error}</div>;
  if (!rows.length) return <div>{empty ?? "No data"}</div>;
  return (
    <div className={TABLE_SHELL}>
      <table className="w-full table-fixed">
        <thead><tr>{columns.map(c => <th key={c.key} className={TABLE_TH}>{c.header}</th>)}</tr></thead>
        <tbody>{rows.map((r, rowIndex) => {
          /* The divider under the final row would double the shell's own
             bottom border, so the last row's cells drop it explicitly
             (`!border-b-0`, which out-specifies the border-b baked into
             TABLE_TD). Composed per cell — a variant like `last:[&>td]`
             compiles to `td:last-child` and strips the whole table's last
             column instead. */
          const isLastRow = rowIndex === rows.length - 1;
          return (
            <tr key={r.id} onClick={() => onRowClick?.(r)} className="cursor-pointer transition-colors hover:bg-[var(--surface-2)]">
              {columns.map(c => (
                <td
                  key={c.key}
                  className={`${TABLE_TD}${c.cellClass ? ` ${c.cellClass}` : ""}${isLastRow ? " !border-b-0" : ""}`}
                  title={String((r as Record<string, unknown>)[c.key] ?? "")}
                >
                  {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? "")}
                </td>
              ))}
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
