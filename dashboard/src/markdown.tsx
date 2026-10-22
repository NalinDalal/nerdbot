/** A small, dependency-free Markdown renderer for run output.
 *
 *  Bots answer in Markdown. Showing that answer in a monospace block makes a
 *  structured result look like a log, which is exactly the wall of text the
 *  workbench is trying to avoid. This parser handles the subset bots actually
 *  produce (headings, paragraphs, lists, quotes, rules, fenced code, bold,
 *  italic, inline code, links) and renders React nodes, never HTML, so run
 *  output cannot inject markup.
 *
 *  Shell runs are not passed through this: their output is a log and is shown
 *  as one.
 */
import type { ReactNode } from "react";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "rule" };

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^:?-{3,}:?$/;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Inline tokens. Underscore emphasis is deliberately not supported: task
 *  output is full of identifiers like `api_key_env`, and italicising the
 *  middle of one is worse than not supporting that syntax. */
const INLINE =
  /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/[^)\s]+)\))/g;

export function parseInline(text: string): Inline[] {
  const tokens = text.split(INLINE);
  const out: Inline[] = [];
  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      out.push({ kind: "strong", text: token.slice(2, -2) });
    } else if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
      out.push({ kind: "em", text: token.slice(1, -1) });
    } else if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
      out.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("[") && token.includes("](")) {
      const close = token.indexOf("](");
      const href = token.slice(close + 2, -1);
      if (/^https?:\/\//.test(href)) {
        out.push({ kind: "link", text: token.slice(1, close), href });
      } else {
        out.push({ kind: "text", text: token });
      }
    } else {
      out.push({ kind: "text", text: token });
    }
  }
  return out;
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line)
  );
}

export function parseMarkdown(text: string): Block[] {
  const source = text.replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (FENCE.test(line)) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1].trim() });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const pattern = ordered ? ORDERED : BULLET;
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(pattern);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (
      TABLE_ROW.test(line) &&
      index + 1 < lines.length &&
      TABLE_ROW.test(lines[index + 1]) &&
      tableCells(lines[index + 1]).every((cell) => TABLE_SEPARATOR.test(cell))
    ) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && TABLE_ROW.test(lines[index])) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(QUOTE);
        if (!match) break;
        quoted.push(match[1].trim());
        index += 1;
      }
      blocks.push({ kind: "quote", text: quoted.join(" ") });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

function inlineNodes(text: string): ReactNode[] {
  return parseInline(text).map((part, index) => {
    switch (part.kind) {
      case "strong":
        return <strong key={index}>{part.text}</strong>;
      case "em":
        return <em key={index}>{part.text}</em>;
      case "code":
        return (
          <code
            key={index}
            className="mono rounded bg-[var(--surface-2)] px-1 py-0.5 text-[0.95em]"
          >
            {part.text}
          </code>
        );
      case "link":
        return (
          <a
            key={index}
            href={part.href}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] underline underline-offset-2"
          >
            {part.text}
          </a>
        );
      default:
        return <span key={index}>{part.text}</span>;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="text-[var(--step-0)] leading-relaxed text-[var(--text-soft)]">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <h3
                key={index}
                className={`mb-1 font-semibold tracking-tight text-[var(--text)] ${
                  index === 0 ? "" : "mt-4"
                }`}
              >
                {inlineNodes(block.text)}
              </h3>
            );
          case "code":
            return (
              <pre
                key={index}
                className="mono my-2 overflow-x-auto rounded-lg bg-[var(--surface-2)] p-3 text-[var(--step-minus-1)] leading-relaxed text-[var(--text-soft)]"
              >
                {block.text}
              </pre>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag
                key={index}
                className={`my-2 flex flex-col gap-1 pl-5 ${
                  block.ordered ? "list-decimal" : "list-disc"
                }`}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="pl-1">
                    {inlineNodes(item)}
                  </li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote
                key={index}
                className="my-2 border-l-2 border-[var(--border)] pl-3 text-[var(--muted)]"
              >
                {inlineNodes(block.text)}
              </blockquote>
            );
          case "table":
            return (
              <div key={index} className="my-3 overflow-x-auto">
                <table className="w-full border-collapse text-[var(--step-minus-1)]">
                  <thead>
                    <tr>
                      {block.headers.map((header, cellIndex) => (
                        <th
                          key={cellIndex}
                          className="border-b border-[var(--border)] px-2 py-1.5 text-left font-semibold text-[var(--text)]"
                        >
                          {inlineNodes(header)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-[var(--border-dim)] last:border-0">
                        {block.headers.map((_, cellIndex) => (
                          <td key={cellIndex} className="px-2 py-1.5 align-top">
                            {inlineNodes(row[cellIndex] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <hr key={index} className="my-4 border-[var(--border-dim)]" />;
          default:
            return (
              <p key={index} className="my-2">
                {inlineNodes(block.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
