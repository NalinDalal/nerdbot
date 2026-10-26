/** The workspace's decisions, tested without a browser.
 *
 *  These are the rules a user feels: which file opens first, what the next
 *  file is, whether a diff counter is honest, and which shortcuts are safe.
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "./types";
import {
  diffStats,
  filterFiles,
  formatBytes,
  isTaskActive,
  isTextPath,
  lineCount,
  modifierLabel,
  pickInitialFile,
  shortcutFor,
  stepFile,
  suggestFiles,
  terminalStatusLabel,
  terminalTheme,
} from "./workbench";

const file = (path: string, size = 10): WorkspaceFile => ({
  path,
  size,
  modified: 0,
});

const key = (over: Partial<Parameters<typeof shortcutFor>[0]> = {}) => ({
  key: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("shortcutFor", () => {
  it("maps save and open on the platform modifier", () => {
    expect(shortcutFor(key({ key: "s", metaKey: true }), true)).toBe("save");
    expect(shortcutFor(key({ key: "s", ctrlKey: true }), false)).toBe("save");
    // The wrong modifier on a platform is ordinary typing.
    expect(shortcutFor(key({ key: "s", ctrlKey: true }), true)).toBeNull();
  });

  it("maps the terminal and run shortcuts", () => {
    expect(shortcutFor(key({ key: "`", metaKey: true }), true)).toBe("focus-terminal");
    expect(shortcutFor(key({ key: "j", metaKey: true }), true)).toBe("toggle-terminal");
    expect(shortcutFor(key({ key: "Enter", metaKey: true }), true)).toBe("run");
    expect(shortcutFor(key({ key: "p", ctrlKey: true }), false)).toBe("find-file");
  });

  it("moves between files with alt and the arrow keys", () => {
    expect(shortcutFor(key({ key: "ArrowUp", altKey: true }), true)).toBe("prev-file");
    expect(shortcutFor(key({ key: "ArrowDown", altKey: true }), false)).toBe("next-file");
    expect(shortcutFor(key({ key: "ArrowDown" }), true)).toBeNull();
  });

  it("opens help on a question mark without a command modifier", () => {
    expect(shortcutFor(key({ key: "?", shiftKey: true }), true)).toBe("help");
    expect(shortcutFor(key({ key: "/", shiftKey: true }), false)).toBe("help");
    // The editor and terminal decide what to do with their own text; help is
    // never claimed while a command modifier is held.
    expect(shortcutFor(key({ key: "?", metaKey: true }), true)).toBeNull();
  });

  it("leaves ordinary characters alone", () => {
    expect(shortcutFor(key({ key: "a" }), true)).toBeNull();
    expect(shortcutFor(key({ key: "Enter" }), true)).toBeNull();
  });
});

describe("modifierLabel", () => {
  it("prints the key the owner actually has", () => {
    expect(modifierLabel("MacIntel")).toBe("⌘");
    expect(modifierLabel("iPhone")).toBe("⌘");
    expect(modifierLabel("Win32")).toBe("Ctrl");
    expect(modifierLabel("Linux x86_64")).toBe("Ctrl");
  });
});

describe("which file opens first", () => {
  const files = [
    file("assets/logo.png"),
    file("src/main.ts"),
    file("docs/README.md"),
  ];

  it("prefers a readme anywhere in the tree", () => {
    expect(pickInitialFile(files)).toBe("docs/README.md");
    expect(pickInitialFile([file("README"), file("src/main.ts")])).toBe("README");
  });

  it("falls back to the first text file, never a binary", () => {
    expect(pickInitialFile([file("logo.png"), file("src/main.ts")])).toBe("src/main.ts");
    expect(pickInitialFile([file("logo.png"), file("app.zip")])).toBeNull();
  });

  it("recognises the text formats a workspace shows", () => {
    expect(isTextPath("src/main.tsx")).toBe(true);
    expect(isTextPath("Dockerfile")).toBe(true);
    expect(isTextPath(".gitignore")).toBe(true);
    expect(isTextPath("archive.tar.gz")).toBe(false);
  });
});

describe("file filtering and stepping", () => {
  const files = [file("src/main.ts"), file("src/admin.tsx"), file("README.md")];

  it("filters by path, case-insensitively", () => {
    expect(filterFiles(files, "ADMIN").map((f) => f.path)).toEqual(["src/admin.tsx"]);
    expect(filterFiles(files, "  ")).toBe(files);
  });

  it("offers only files that can be read as text", () => {
    expect(
      suggestFiles([file("logo.png"), file("README.md"), file("index.html")], 2).map(
        (f) => f.path,
      ),
    ).toEqual(["README.md", "index.html"]);
  });

  it("steps without wrapping past either end", () => {
    const paths = files.map((f) => f.path);
    expect(stepFile(paths, "src/main.ts", 1)).toBe("src/admin.tsx");
    expect(stepFile(paths, "README.md", 1)).toBeNull();
    expect(stepFile(paths, "src/main.ts", -1)).toBeNull();
    expect(stepFile(paths, "src/admin.tsx", -1)).toBe("src/main.ts");
    expect(stepFile(paths, null, 1)).toBe("src/main.ts");
    expect(stepFile([], null, 1)).toBeNull();
  });
});

describe("diff and editor accounting", () => {
  it("counts changed lines but not file headers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      "-old",
      "+new",
      "+another",
    ].join("\n");
    expect(diffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it("counts lines and empty content honestly", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("one")).toBe(1);
    expect(lineCount("one\ntwo\n")).toBe(3);
  });

  it("formats file sizes for a compact rail", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(15 * 1024)).toBe("15 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("task and terminal state", () => {
  it("polls only while a task can still change", () => {
    for (const status of ["pending", "ready", "running", "awaiting_approval"]) {
      expect(isTaskActive(status)).toBe(true);
    }
    for (const status of ["done", "failed", "cancelled", null, undefined]) {
      expect(isTaskActive(status)).toBe(false);
    }
  });

  it("uses a distinct palette per theme", () => {
    const dark = terminalTheme(true);
    const light = terminalTheme(false);
    expect(dark.background).not.toBe(light.background);
    expect(dark.foreground).not.toBe(light.foreground);
    // Both cursors are accent green, but each is tuned for its background.
    expect(dark.cursor).not.toBe(light.cursor);
  });

  it("names every terminal state", () => {
    expect(terminalStatusLabel("idle")).toBe("Idle");
    expect(terminalStatusLabel("connecting")).toBe("Starting");
    expect(terminalStatusLabel("ready")).toBe("Connected");
    expect(terminalStatusLabel("exited")).toBe("Session ended");
    expect(terminalStatusLabel("error")).toBe("Unavailable");
  });
});
