/** N2 guard: the dashboard must render untrusted data only via React text
 * nodes — no HTML-injection sinks anywhere in the source. Enforced by the
 * suite so a future slice can not silently reintroduce one without a
 * conscious, reviewed change to this test. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SINKS = ["innerHTML", "dangerouslySetInnerHTML", "__html"];

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

describe("no HTML-injection sinks (N2 guard)", () => {
  it("dashboard source contains no innerHTML / dangerouslySetInnerHTML", () => {
    const offenders = sourceFiles("src").filter((file) =>
      SINKS.some((sink) => readFileSync(file, "utf8").includes(sink)),
    );
    expect(offenders).toEqual([]);
  });
});
