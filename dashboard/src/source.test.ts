/** N2 guard: the dashboard must render untrusted data only via React text
 * nodes — no HTML-injection sinks anywhere in the source. Enforced by the
 * suite so a future slice can not silently reintroduce one without a
 * conscious, reviewed change to this test. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SINKS = ["innerHTML", "dangerouslySetInnerHTML", "__html"];

// Allowed only where untrusted-ish content is explicitly sanitized before render.
// Keep this list narrow and reviewed.
const SANITIZED_HTML_ALLOWLIST = new Set(["src/views-library.tsx"]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.(tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

describe("the bundle is built from TypeScript sources", () => {
  it("has no compiled .js artifact sitting beside a .ts/.tsx file", () => {
    // A committed app.js shadowed app.tsx for Vite, so every UI change since
    // the artifact was written shipped nothing. tsc reported success because
    // it checked the .tsx files the bundler never read.
    const orphans: string[] = [];
    const walk = (dir: string): string[] => {
      const found: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...walk(path));
        else if (entry.name.endsWith(".js")) found.push(path);
      }
      return found;
    };
    for (const file of walk("src")) {
      const base = file.slice(0, -3);
      if (existsSync(`${base}.ts`) || existsSync(`${base}.tsx`)) orphans.push(file);
    }
    expect(orphans).toEqual([]);
  });
});

describe("no HTML-injection sinks (N2 guard)", () => {
  it("dashboard source contains no innerHTML / dangerouslySetInnerHTML", () => {
    const offenders = sourceFiles("src").filter((file) => {
      const text = readFileSync(file, "utf8");
      const hasSink = SINKS.some((sink) => text.includes(sink));
      if (!hasSink) return false;
      // Library HTML preview is rendered only via sanitizeHtml(...) before __html.
      if (SANITIZED_HTML_ALLOWLIST.has(file.replace(/\\/g, "/")) && text.includes("sanitizeHtml(")) {
        return false;
      }
      return true;
    });
    expect(offenders).toEqual([]);
  });
});
