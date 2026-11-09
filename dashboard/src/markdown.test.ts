import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("parseMarkdown", () => {
  it("splits headings, paragraphs and rules", () => {
    expect(parseMarkdown("### One\n\nA line\nand another\n\n---\n\nDone.")).toEqual([
      { kind: "heading", text: "One" },
      { kind: "paragraph", text: "A line and another" },
      { kind: "rule" },
      { kind: "paragraph", text: "Done." },
    ]);
  });

  it("keeps list items together", () => {
    expect(parseMarkdown("- one\n- two\n1. first\n2. second")).toEqual([
      { kind: "list", ordered: false, items: ["one", "two"] },
      { kind: "list", ordered: true, items: ["first", "second"] },
    ]);
  });

  it("keeps fenced code verbatim and unclosed fences", () => {
    expect(parseMarkdown("```sh\nnerdbot run\n  --port 8080\n```")).toEqual([
      { kind: "code", text: "nerdbot run\n  --port 8080" },
    ]);
    expect(parseMarkdown("```\nstill open")).toEqual([{ kind: "code", text: "still open" }]);
  });

  it("collects quotes", () => {
    expect(parseMarkdown("> one\n> two")).toEqual([{ kind: "quote", text: "one two" }]);
  });
});

describe("parseInline", () => {
  it("finds bold, italic, code and http links", () => {
    expect(parseInline("**bold** and *it* and `code` and [docs](https://example.com)")).toEqual([
      { kind: "strong", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "em", text: "it" },
      { kind: "text", text: " and " },
      { kind: "code", text: "code" },
      { kind: "text", text: " and " },
      { kind: "link", text: "docs", href: "https://example.com" },
    ]);
  });

  it("does not turn an identifier's underscores into emphasis", () => {
    expect(parseInline("set api_key_env first")).toEqual([
      { kind: "text", text: "set api_key_env first" },
    ]);
  });

  it("refuses non-http links", () => {
    expect(parseInline("[run](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[run](javascript:alert(1))" },
    ]);
  });
});

describe("tables", () => {
  it("parses a header, separator and body rows", () => {
    expect(parseMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |")).toEqual([
      { kind: "table", headers: ["A", "B"], rows: [["1", "2"], ["3", "4"]] },
    ]);
  });

  it("leaves a pipe line alone when there is no separator", () => {
    expect(parseMarkdown("| not | a table |")).toEqual([
      { kind: "paragraph", text: "| not | a table |" },
    ]);
  });
});


describe("safety", () => {
  it("does not produce image blocks from image syntax", () => {
    const blocks = parseMarkdown("![remote](https://example.com/x.png)");
    // No image block type exists; nothing auto-loads.
    expect(blocks.every((b) => b.kind !== ("image" as any))).toBe(true);
  });
  it("only http(s) links become link tokens", () => {
    expect(parseInline("[x](ftp://example.com)")).toEqual([{ kind: "text", text: "[x](ftp://example.com)" }]);
    expect(parseInline("[x](https://example.com)")).toEqual([{ kind: "link", text: "x", href: "https://example.com" }]);
  });
});
