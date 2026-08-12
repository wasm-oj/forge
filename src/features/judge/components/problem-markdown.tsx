import { Fragment, useMemo, type ReactNode } from "react";

type MarkdownBlock =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

function isBlockBoundary(line: string): boolean {
  return (
    !line.trim()
    || /^#{1,3}\s/.test(line)
    || line.startsWith("```")
    || /^[-*]\s+/.test(line)
    || /^\d+\.\s+/.test(line)
    || line.startsWith("<!--")
  );
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim() || line.startsWith("# ")) {
      index += 1;
      continue;
    }
    if (line.startsWith("<!--")) {
      while (index < lines.length && !lines[index].includes("-->")) index += 1;
      index += 1;
      continue;
    }
    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length as 2 | 3, text: heading[2] });
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      index += 1;
      const contents: string[] = [];
      while (index < lines.length && !lines[index].startsWith("```")) {
        contents.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) throw new Error("Problem Markdown contains an unterminated code fence.");
      blocks.push({ kind: "code", text: contents.join("\n") });
      index += 1;
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      const itemPattern = isOrdered ? /^\d+\.\s+(.+)$/ : /^[-*]\s+(.+)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const item = itemPattern.exec(lines[index]);
        if (!item) break;
        index += 1;
        const parts = [item[1]];
        while (index < lines.length && !isBlockBoundary(lines[index])) {
          parts.push(lines[index].trim());
          index += 1;
        }
        items.push(parts.join(" "));
        if (!lines[index]?.trim()) index += 1;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlockBoundary(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function inline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function ProblemMarkdown({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <div className="problem-markdown">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return block.level === 2
            ? <h2 key={index}>{inline(block.text)}</h2>
            : <h3 key={index}>{inline(block.text)}</h3>;
        }
        if (block.kind === "paragraph") return <p key={index}>{inline(block.text)}</p>;
        if (block.kind === "code") return <pre key={index}><code>{block.text}</code></pre>;
        const List = block.ordered ? "ol" : "ul";
        return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</List>;
      })}
    </div>
  );
}
