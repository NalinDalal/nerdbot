"use client";

import { ReactNode } from "react";

export interface ButtonProps {
  /** Primary/secondary/ghost/accent/danger */
  variant?: "primary" | "secondary" | "link" | "ghost";
  /** Disabled state */
  disabled?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Button text/children */
  children: ReactNode;
  /** Optional icon before children */
  startIcon?: ReactNode;
  /** Optional icon after children */
  endIcon?: ReactNode;
  /** Size: default | sm | lg */
  size?: "default" | "sm" | "lg";
  /** Full width (100%) */
  fullWidth?: boolean;
  /** Additional Tailwind classes */
  className?: string;
}

export function Button({
  variant = "primary",
  disabled = false,
  onClick,
  children,
  startIcon,
  endIcon,
  size = "default",
  fullWidth = false,
  className,
}: ButtonProps) => {
  // Size classes
  const sizeClasses = {
    sm: "px-3 py-1.5 text-sm",
    default: "px-4 py-2 text-base",
    lg: "px-6 py-3 text-lg",
  };

  // Variant base classes using EXISTING token names from styles.css
  let variantClasses = "";

  switch (variant) {
    case "primary":
      variantClasses =
        "inline-flex items-center justify-center rounded-lg bg-[var(--accent)] text-white hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--accent)] shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed";
      break;

    case "secondary":
      variantClasses =
        "inline-flex items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text)] px-4 py-2 text-base font-medium transition-colors hover:bg-[var(--surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--muted)] shadow-sm disabled:opacity-50 disabled:cursor-not-allowed";
      break;

    case "link":
      variantClasses =
        "text-[var(--text)] underline underline-offset-4 hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-0";
      break;

    case "ghost":
      variantClasses =
        "text-[var(--muted)] hover:text-[var(--text)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
      break;
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        inline-flex items-center justify-center rounded-lg transition-all duration-150
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
        ${variantClasses}
        ${sizeClasses[size]}
        ${fullWidth ? "w-full" : ""}
        shadow-sm hover:shadow-md
        disabled:opacity-50 disabled:cursor-not-allowed
        group-hover:transition-colors group-hover:duration-150
        group-active:scale-105 group-active:translate-y-1
        ${className || ""}
      `}
    >
      {startIcon && <span className="mr-2">{startIcon}</span>}
      {children}
      {endIcon && <span className="ml-2">{endIcon}</span>}
    </button>
  );
};