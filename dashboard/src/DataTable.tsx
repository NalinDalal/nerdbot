import { TABLE_SHELL, TABLE_TD, TABLE_TH } from "./components";

export interface Column<T> { key: string; header: string; render?: (row: T) => React.ReactNode; }

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
        <tbody>{rows.map((r) => (
          <tr key={r.id} onClick={() => onRowClick?.(r)} className="cursor-pointer transition-colors last:[&>td]:border-b-0 hover:bg-[var(--surface-2)]">
            {columns.map(c => <td key={c.key} className={TABLE_TD} title={String((r as Record<string, unknown>)[c.key] ?? "")}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? "")}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
