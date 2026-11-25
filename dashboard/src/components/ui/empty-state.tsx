"use client";

import { ReactNode } from "react";

export interface EmptyStateProps {
  /** Optional illustrative icon/diagram element */
  icon?: ReactNode;
  /** Headline text */
  headline: string;
  /** Subheadline/description text */
  subheadline?: string;
  /** Primary CTA button props */
  cta?: {
    label: string;
    onClick: () => void;
    variant?: "primary" | "secondary";
  };
  /** Optional trailing text/action */
  trailing?: ReactNode;
  /** Additional Tailwind classes */
  className?: string;
}

export function EmptyState({
  icon,
  headline,
  subheadline,
  cta,
  trailing,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={`
        empty-state min-h-[250px] flex flex-col items-center justify-center text-center py-12
        ${className || ""}
      `}
    >
      {icon && <div className="mb-6">{icon}</div>}
      <h2 className="text-[var(type-heading-xl)] font-semibold text-[var(--text)] mb-2">
        {headline}
      </h2>
      {subheadline && (
        <p className="text-[var(type-body)] text-[var(--muted)] mb-6 leading-relaxed">
          {subheadline}
        </p>
      )}
      {cta && (
        <div className="flex gap-3">
          {cta.variant === "primary" ? (
            <button
              onClick={cta.onClick}
              className="inline-flex items-center justify-center rounded-lg bg-[var(--accent)] text-white px-4 py-2 text-base font-medium transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 shadow-sm"
            >
              {cta.label}
            </button>
          ) : (
            <button
              onClick={cta.onClick}
              className="inline-flex items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text)] px-4 py-2 text-base font-medium transition-colors hover:bg-[var(--surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--muted)] focus-visible:ring-offset-2 shadow-sm"
            >
              {cta.label}
            </button>
          )}
        </div>
      )}
      {trailing && <div className="mt-4 text-[var(type-xs)] text-[var(--muted)]">{trailing}</div>}
    </div>
  );
};