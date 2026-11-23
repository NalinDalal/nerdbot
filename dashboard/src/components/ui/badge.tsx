"use client";

import { ReactNode } from "react";

export interface BadgeProps {
  /** Badge content */
  children: ReactNode;
  /** Variant: default | secondary | accent | danger | success */
  variant?: "default" | "secondary" | "accent" | "danger" | "success";
  /** Size: sm | lg */
  size?: "sm" | "lg";
  /** Inverted colors (light on dark) */
  inverted?: boolean;
  /** Additional Tailwind classes */
  className?: string;
}

export function Badge({
  children,
  variant = "default",
  size = "sm",
  inverted = false,
  className,
}: BadgeProps) => {
  // Determine styles based on EXISTING token names from styles.css
  let bg = "";
  let color = "";
  let border = "";

  switch (variant) {
    case "default":
      bg = "var(--surface)";
      color = "var(--text)";
      border = "1px solid var(--border)";
      break;

    case "secondary":
      bg = "var(--surface)";
      color = "var(--muted)";
      border = "1px solid var(--border)";
      break;

    case "accent":
      bg = "var(--accent)";
      color = "white";
      border = "none";
      break;

    case "danger":
      bg = "#EF4444"; // use existing danger color from styles.css
      color = "var(--danger)";
      border = "none";
      break;

    case "success":
      bg = "#22C55E"; // use existing success color from styles.css
      color = "var(--success)";
      border = "none";
      break;
  }

  const sizeClasses = {
    sm: "h-6 rounded text-xs px-2.5",
    lg: "h-8 rounded text-sm px-3.5",
  };

  return (
    <span
      className={`
        inline-flex items-center rounded${border ? "" : "-full"} ${sizeClasses[size]}
        ${bg && `bg-${bg}`}
        ${color && `text-${color}`}
        ${border && `border-${border}`}
        align-middle
        inline-flex items-center
        px-2.5 py-0.5
        transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2
        ${className || ""}
      `}
    >
      {children}
    </span>
  );
};