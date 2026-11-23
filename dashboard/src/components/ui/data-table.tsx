"use client";

import { ReactNode } from "react";

export interface DataTableHeadCell = {
  header: string;
  className?: string;
};

export interface DataTableRow = {
  cells: string[];
  onClick?: () => void;
  className?: string;
};

export interface DataTableProps {
  /** Table headers */
  headers: string[] | DataTableHeadCell[];
  /** Table rows */
  rows: DataTableRow[];
  /** Caption/title above table */
  caption?: string;
  /** Whether to show striping */
  striped?: boolean;
  /** Whether row clicking is enabled */
  selectable?: boolean;
  /** On row select/click */
  onRowSelect?: (row: DataTableRow) => void;
  /** Empty state to show when no rows */
  emptyState?: {
    headline: string;
    subheadline?: string;
    cta?: { label: string; onClick: () => void; variant?: "primary" | "secondary" };
  };
  /** Additional Tailwind classes */
  className?: string;
}

export function DataTable({
  headers,
  rows,
  caption,
  striped = true,
  selectable = false,
  onRowSelect,
  emptyState,
  className,
}: DataTableProps) => {
  // Transform headers
  const tableHeaders = Array.isArray(headers)
    ? headers.map((h) => ({ header: h, className: h } as DataTableHeadCell))
    : headers;

  return (
    <div className={`
      rounded-lg overflow-hidden
      ${className || ""}
    `}>
      {caption && (
        <div className="px-4 py-3 border-b border-[var(--border)] text-[var(type-sm)] text-[var(--muted)]">
          {caption}
        </div>
      )}

      {rows.length === 0 && emptyState ? (
        <div className="p-6 text-center">
          {emptyState.headline && <h3 className="text-[var(type-heading-sm)] font-medium text-[var(--text)] mb-2">{emptyState.headline}</h3>}
          {emptyState.subheadline && <p className="text-[var(type-body)] text-[var(muted)]">{emptyState.subheadline}</p>}
          {emptyState.cta && (
            <button
              onClick={emptyState.cta.onClick}
              className="inline-flex items-center justify-center rounded-lg bg-[var(--accent)] text-white px-4 py-2 text-base font-medium transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 shadow-sm"
            >
              {emptyState.cta.label}
            </button>
          )}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              {tableHeaders.map((h, i) => (
                <th
                  key={i}
                  className={`
                    py-3 px-4 text-left text-xs font-medium uppercase tracking-[0.1em] text-[var(--muted)]
                    ${h.className || ""}
                  `}
                >
                  {h.header}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((row, rowIndex) => {
              // Row classes: striping + selectable hover
              const rowClasses = [
                "border-b",
                striped && rowIndex % 2 === 0 && "bg-[var(--surface)]",
                selectable && "cursor-pointer hover:bg-[var(--surface)] transition-colors",
                row.className || "",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <tr
                  key={rowIndex}
                  className={rowClasses}
                  onClick={row.onClick || onRowSelect ? () => onRowSelect(row) : undefined}
                >
                  {row.cells.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={`
                        py-3 px-4 text-[var(type-body)] text-[var(--text)] text-sm
                        whitespace-nowrap
                      `}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};