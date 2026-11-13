import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^:?-{3,}:?$/;
function tableCells(line) {
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
const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/[^)\s]+)\))/g;
export function parseInline(text) {
    const tokens = text.split(INLINE);
    const out = [];
    for (const token of tokens) {
        if (!token)
            continue;
        if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
            out.push({ kind: "strong", text: token.slice(2, -2) });
        }
        else if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
            out.push({ kind: "em", text: token.slice(1, -1) });
        }
        else if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
            out.push({ kind: "code", text: token.slice(1, -1) });
        }
        else if (token.startsWith("[") && token.includes("](")) {
            const close = token.indexOf("](");
            const href = token.slice(close + 2, -1);
            if (/^https?:\/\//.test(href)) {
                out.push({ kind: "link", text: token.slice(1, close), href });
            }
            else {
                out.push({ kind: "text", text: token });
            }
        }
        else {
            out.push({ kind: "text", text: token });
        }
    }
    return out;
}
function startsBlock(line) {
    return (FENCE.test(line) ||
        HEADING.test(line) ||
        RULE.test(line) ||
        BULLET.test(line) ||
        ORDERED.test(line) ||
        QUOTE.test(line) ||
        TABLE_ROW.test(line));
}
export function parseMarkdown(text) {
    const source = text.replace(/\r\n?/g, "\n");
    const lines = source.split("\n");
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
            index += 1;
            continue;
        }
        if (FENCE.test(line)) {
            index += 1;
            const code = [];
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
            const items = [];
            while (index < lines.length) {
                const match = lines[index].match(pattern);
                if (!match)
                    break;
                items.push(match[1].trim());
                index += 1;
            }
            blocks.push({ kind: "list", ordered, items });
            continue;
        }
        if (TABLE_ROW.test(line) &&
            index + 1 < lines.length &&
            TABLE_ROW.test(lines[index + 1]) &&
            tableCells(lines[index + 1]).every((cell) => TABLE_SEPARATOR.test(cell))) {
            const headers = tableCells(line);
            index += 2;
            const rows = [];
            while (index < lines.length && TABLE_ROW.test(lines[index])) {
                rows.push(tableCells(lines[index]));
                index += 1;
            }
            blocks.push({ kind: "table", headers, rows });
            continue;
        }
        if (QUOTE.test(line)) {
            const quoted = [];
            while (index < lines.length) {
                const match = lines[index].match(QUOTE);
                if (!match)
                    break;
                quoted.push(match[1].trim());
                index += 1;
            }
            blocks.push({ kind: "quote", text: quoted.join(" ") });
            continue;
        }
        const paragraph = [line.trim()];
        index += 1;
        while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
            paragraph.push(lines[index].trim());
            index += 1;
        }
        blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    }
    return blocks;
}
function inlineNodes(text) {
    return parseInline(text).map((part, index) => {
        switch (part.kind) {
            case "strong":
                return _jsx("strong", { children: part.text }, index);
            case "em":
                return _jsx("em", { children: part.text }, index);
            case "code":
                return (_jsx("code", { className: "mono rounded bg-[var(--surface-2)] px-1 py-0.5 text-[0.95em]", children: part.text }, index));
            case "link":
                return (_jsx("a", { href: part.href, target: "_blank", rel: "noopener noreferrer", className: "text-[var(--accent)] underline underline-offset-2", children: part.text }, index));
            default:
                return _jsx("span", { children: part.text }, index);
        }
    });
}
export function Markdown({ text }) {
    const blocks = parseMarkdown(text);
    return (_jsx("div", { className: "text-step-0 leading-relaxed text-[var(--text-soft)]", children: blocks.map((block, index) => {
            switch (block.kind) {
                case "heading":
                    return (_jsx("h3", { className: `mb-1 font-semibold tracking-tight text-[var(--text)] ${index === 0 ? "" : "mt-4"}`, children: inlineNodes(block.text) }, index));
                case "code":
                    return (_jsx("pre", { className: "mono my-2 overflow-x-auto rounded-lg bg-[var(--surface-2)] p-3 text-step--1 leading-relaxed text-[var(--text-soft)]", children: block.text }, index));
                case "list": {
                    const Tag = block.ordered ? "ol" : "ul";
                    return (_jsx(Tag, { className: `my-2 flex flex-col gap-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`, children: block.items.map((item, itemIndex) => (_jsx("li", { className: "pl-1", children: inlineNodes(item) }, itemIndex))) }, index));
                }
                case "quote":
                    return (_jsx("blockquote", { className: "my-2 border-l-2 border-[var(--border)] pl-3 text-[var(--muted)]", children: inlineNodes(block.text) }, index));
                case "table":
                    return (_jsx("div", { className: "my-3 overflow-x-auto", children: _jsxs("table", { className: "w-full border-collapse text-step--1", children: [_jsx("thead", { children: _jsx("tr", { children: block.headers.map((header, cellIndex) => (_jsx("th", { className: "border-b border-[var(--border)] px-2 py-1.5 text-left font-semibold text-[var(--text)]", children: inlineNodes(header) }, cellIndex))) }) }), _jsx("tbody", { children: block.rows.map((row, rowIndex) => (_jsx("tr", { className: "border-b border-[var(--border-dim)] last:border-0", children: block.headers.map((_, cellIndex) => (_jsx("td", { className: "px-2 py-1.5 align-top", children: inlineNodes(row[cellIndex] ?? "") }, cellIndex))) }, rowIndex))) })] }) }, index));
                case "rule":
                    return _jsx("hr", { className: "my-4 border-[var(--border-dim)]" }, index);
                default:
                    return (_jsx("p", { className: "my-2", children: inlineNodes(block.text) }, index));
            }
        }) }));
}
