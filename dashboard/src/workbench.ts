/** Pure workspace rules shared by the workbench UI.
 *
 *  Keeping these out of the view means the behaviour that decides what opens,
 *  what the next file is, and how a diff is counted can be tested without a
 *  browser or a running API. The view stays about layout and interaction.
 */
import type { ITheme } from "@xterm/xterm";
import type { WorkspaceFile } from "./types";

export type WorkbenchPane = "files" | "editor" | "terminal" | "review";

export const WORKBENCH_PANES: Array<{ id: WorkbenchPane; label: string }> = [
  { id: "files", label: "Files" },
  { id: "editor", label: "Editor" },
  { id: "terminal", label: "Terminal" },
  { id: "review", label: "Review" },
];

export type TerminalStatus = "idle" | "connecting" | "ready" | "exited" | "error";

export type WorkbenchCommand =
  | "save"
  | "open"
  | "find-file"
  | "run"
  | "focus-terminal"
  | "toggle-terminal"
  | "prev-file"
  | "next-file"
  | "help";

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The modifier the UI prints in shortcut hints. */
export function modifierLabel(platform: string): string {
  return /Mac|iPod|iPhone|iPad/i.test(platform) ? "⌘" : "Ctrl";
}

/** Map a key event onto one workspace command, or null when it is ordinary
 *  typing. Shortcuts are modifier-led so they never steal a character from
 *  the editor or the terminal. */
export function shortcutFor(event: KeyEventLike, apple: boolean): WorkbenchCommand | null {
  const mod = apple ? event.metaKey : event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (mod && !event.altKey) {
    if (key === "s") return "save";
    if (key === "o") return "open";
    if (key === "p") return "find-file";
    if (key === "j") return "toggle-terminal";
    if (key === "`") return "focus-terminal";
    if (key === "enter") return "run";
  }

  if (event.altKey && !mod) {
    if (key === "arrowup") return "prev-file";
    if (key === "arrowdown") return "next-file";
  }

  if ((event.key === "?" || (event.shiftKey && key === "/")) && !mod && !event.altKey) {
    return "help";
  }
  return null;
}

const TEXT_EXTENSIONS = new Set([
  "bash",
  "c",
  "cfg",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "env",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "less",
  "log",
  "md",
  "mdx",
  "mjs",
  "cjs",
  "php",
  "py",
  "rb",
  "rs",
  "rst",
  "scss",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

function baseName(path: string): string {
  const parts = path.split("/");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

export function isTextPath(path: string): boolean {
  const name = baseName(path);
  if (name === "readme" || name.startsWith("readme.")) return true;
  if (name === ".gitignore" || name === ".env" || name === "dockerfile") return true;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1));
}

/** The file a workspace should open by itself: its README if it has one,
 *  otherwise the first file that is safe to show as text. Auto-opening a
 *  binary would turn a useful landing state into an error toast. */
export function pickInitialFile(files: WorkspaceFile[]): string | null {
  const readme = files.find((file) => {
    const name = baseName(file.path);
    return name === "readme" || name.startsWith("readme.");
  });
  if (readme) return readme.path;
  const text = files.find((file) => isTextPath(file.path));
  return text?.path ?? null;
}

/** Files worth offering in an empty editor, in reading order. */
export function suggestFiles(files: WorkspaceFile[], limit = 3): WorkspaceFile[] {
  return files.filter((file) => isTextPath(file.path)).slice(0, limit);
}

/** Case-insensitive path filter. An empty query is the identity. */
export function filterFiles(files: WorkspaceFile[], query: string): WorkspaceFile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files;
  return files.filter((file) => file.path.toLowerCase().includes(needle));
}

/** Move through the visible file list. Returns null at either end so the
 *  caller can disable the control instead of wrapping unexpectedly. */
export function stepFile(
  paths: string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (paths.length === 0) return null;
  const index = current ? paths.indexOf(current) : -1;
  if (index === -1) return delta > 0 ? paths[0] : paths[paths.length - 1];
  const next = index + delta;
  if (next < 0 || next >= paths.length) return null;
  return paths[next];
}

/** Additions and deletions in a unified diff, excluding file headers. */
export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/** Lines in the editor, counted the way a code editor counts them. */
export function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").length;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** A task keeps updating the Run panel only while it can still change. */
export function isTaskActive(status: string | null | undefined): boolean {
  return (
    status === "pending" ||
    status === "ready" ||
    status === "running" ||
    status === "awaiting_approval"
  );
}

/** Terminal palette. xterm draws on a canvas, so CSS custom properties are
 *  not usable here: these values mirror the light/dark tokens in styles.css. */
export function terminalTheme(dark: boolean): ITheme {
  if (dark) {
    return {
      background: "#12181c",
      foreground: "#e7ecf0",
      cursor: "#3ab078",
      cursorAccent: "#0a0d10",
      selectionBackground: "rgba(46, 158, 107, 0.30)",
      selectionInactiveBackground: "rgba(46, 158, 107, 0.16)",
      black: "#0a0d10",
      red: "#d75f5d",
      green: "#2e9e6b",
      yellow: "#c98f33",
      blue: "#5aa9e6",
      magenta: "#c084fc",
      cyan: "#5aa9e6",
      white: "#e7ecf0",
      brightBlack: "#79899a",
      brightRed: "#f08a88",
      brightGreen: "#3ab078",
      brightYellow: "#e0a94a",
      brightBlue: "#7abdf0",
      brightMagenta: "#d6a6ff",
      brightCyan: "#7abdf0",
      brightWhite: "#ffffff",
      scrollbarSliderBackground: "rgba(185, 196, 207, 0.18)",
      scrollbarSliderHoverBackground: "rgba(185, 196, 207, 0.30)",
      scrollbarSliderActiveBackground: "rgba(185, 196, 207, 0.40)",
    };
  }
  return {
    background: "#ffffff",
    foreground: "#0f171d",
    cursor: "#2e9e6b",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(46, 158, 107, 0.22)",
    selectionInactiveBackground: "rgba(46, 158, 107, 0.12)",
    black: "#f7f8f9",
    red: "#c0504f",
    green: "#2a8c5f",
    yellow: "#b07a2c",
    blue: "#4589c7",
    magenta: "#865ac7",
    cyan: "#4589c7",
    white: "#0f171d",
    brightBlack: "#68737f",
    brightRed: "#a83f3e",
    brightGreen: "#237a53",
    brightYellow: "#96661f",
    brightBlue: "#3878ae",
    brightMagenta: "#7348b4",
    brightCyan: "#3878ae",
    brightWhite: "#000000",
    scrollbarSliderBackground: "rgba(93, 104, 115, 0.20)",
    scrollbarSliderHoverBackground: "rgba(93, 104, 115, 0.32)",
    scrollbarSliderActiveBackground: "rgba(93, 104, 115, 0.42)",
  };
}

/** A compact, human status for the terminal header. */
export function terminalStatusLabel(status: TerminalStatus): string {
  if (status === "idle") return "Idle";
  if (status === "connecting") return "Starting";
  if (status === "ready") return "Connected";
  if (status === "exited") return "Session ended";
  return "Unavailable";
}
