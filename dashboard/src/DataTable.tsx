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

/** How a row lays out in the stack mode (narrow screens): one column's
 *  render is the title, an optional status-like column sits beside it,
 *  and the rest become labelled lines beneath. Columns are named by key,
 *  so the same render functions drive both layouts — nothing drifts. */
export interface StackSpec {
  title: string;
  badge?: string;
  meta?: string[];
}

function cellText<T extends { id: string }>(row: T, key: string): string {
  return String((row as Record<string, unknown>)[key] ?? "");
}

export function DataTable<T extends { id: string }>({ columns, rows, onRowClick, loading, empty, error, stack }: {
  columns: Column<T>[]; rows: T[]; onRowClick?: (row: T) => void;
  loading?: boolean; empty?: string; error?: string;
  /** Present: rows also render as stacked blocks under 640px, where a
   *  fixed table has nowhere to put this many columns. */
  stack?: StackSpec;
}) {
  if (loading) return <div>Loading…</div>;
  if (error) return <div>{error}</div>;
  if (!rows.length) return <div>{empty ?? "No data"}</div>;
  const table = (
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
                  title={cellText(r, c.key)}
                >
                  {c.render ? c.render(r) : cellText(r, c.key)}
                </td>
              ))}
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
  if (!stack) return table;
  const byKey = (key: string): Column<T> | undefined => columns.find(c => c.key === key);
  const titleColumn = byKey(stack.title);
  const badgeColumn = stack.badge ? byKey(stack.badge) : undefined;
  const metaColumns = (stack.meta ?? [])
    .map(byKey)
    .filter((c): c is Column<T> => Boolean(c));
  return (
    <div>
      <div className="max-sm:hidden">{table}</div>
      {/* Hidden from sm up: the table above is the desktop layout. The
          card shell (border, surface, rounding) applies only below sm. */}
      <div className="overflow-x-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] sm:hidden">
        {rows.map((r, i) => (
          <div
            key={r.id}
            onClick={() => onRowClick?.(r)}
            className={`cursor-pointer min-w-0 px-3 py-3 transition-colors hover:bg-[var(--surface-2)] ${
              i > 0 ? "border-t border-[var(--border-dim)]" : ""
            }`}
          >
            {/* Title on top, status beneath, labelled meta lines last —
                header order without the fixed grid. */}
            {titleColumn ? (
              <div className="min-w-0">{titleColumn.render ? titleColumn.render(r) : cellText(r, stack.title)}</div>
            ) : null}
            {badgeColumn ? (
              <div className="mt-2 min-w-0">{badgeColumn.render ? badgeColumn.render(r) : cellText(r, stack.badge ?? "")}</div>
            ) : null}
            {metaColumns.map(c => (
              <div key={c.key} className="mt-1 flex items-baseline gap-2 text-step--2 text-[var(--muted)]">
                <span className="shrink-0">{c.header}</span>
                <span className="min-w-0 break-words">{c.render ? c.render(r) : cellText(r, c.key)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
