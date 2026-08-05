/**
 * Transcript formatting parser (spec 048 round 4b). The assistants answer
 * in a small markdown subset — bold, links, numbered/bulleted lists,
 * headings. Printing the control characters made the appendix nearly
 * unreadable; rendering them shows the answer as the assistant's own UI
 * would have. The WORDS are untouched: this parses presentation, never
 * rewrites content.
 *
 * Security: answers are untrusted text on a public page (docs/12). The
 * parser returns a typed AST that the renderer maps to React elements —
 * no HTML ever passes through — and only http/https URLs become links;
 * anything else stays literal text.
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: InlineNode[] }
  | { kind: "link"; href: string; children: InlineNode[] };

export type BlockNode =
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "heading"; children: InlineNode[] }
  | { kind: "ordered-list"; items: InlineNode[][] }
  | { kind: "bullet-list"; items: InlineNode[][] };

const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;
const BOLD = /\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*/;

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let rest = text;
  while (rest.length > 0) {
    const link = LINK.exec(rest);
    const bold = BOLD.exec(rest);
    const next =
      link && (!bold || link.index <= bold.index)
        ? { match: link, kind: "link" as const }
        : bold
          ? { match: bold, kind: "bold" as const }
          : null;
    if (!next) {
      nodes.push({ kind: "text", text: rest });
      break;
    }
    if (next.match.index > 0) {
      nodes.push({ kind: "text", text: rest.slice(0, next.match.index) });
    }
    if (next.kind === "link") {
      nodes.push({
        kind: "link",
        href: next.match[2]!,
        children: parseInline(next.match[1]!),
      });
    } else {
      nodes.push({ kind: "bold", children: parseInline(next.match[1]!) });
    }
    rest = rest.slice(next.match.index + next.match[0].length);
  }
  return nodes;
}

export function parseTranscript(answer: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  const lines = answer.split("\n");
  let paragraph: string[] = [];
  let list: { kind: "ordered-list" | "bullet-list"; items: InlineNode[][] } | null = null;

  // The assistants write "loose" lists — a blank line between numbered
  // items — and each source item is literally "1." (their apps renumber).
  // A blank line therefore only ENDS a list when what follows isn't
  // another item of the same kind; otherwise the list continues and the
  // <ol> renumbers sequentially, exactly as the asker's screen did.
  let blankAfterList = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ")) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
    blankAfterList = false;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);

    if (trimmed === "") {
      flushParagraph();
      if (list) blankAfterList = true;
    } else if (ordered) {
      flushParagraph();
      if (list?.kind !== "ordered-list") {
        flushList();
        list = { kind: "ordered-list", items: [] };
      }
      list.items.push(parseInline(ordered[1]!));
      blankAfterList = false;
    } else if (bullet) {
      flushParagraph();
      if (list?.kind !== "bullet-list") {
        flushList();
        list = { kind: "bullet-list", items: [] };
      }
      list.items.push(parseInline(bullet[1]!));
      blankAfterList = false;
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", children: parseInline(heading[1]!) });
    } else if (list && blankAfterList) {
      // Prose after a blank line ends the list — it's a new paragraph,
      // not a continuation of the last item.
      flushList();
      paragraph.push(trimmed);
    } else if (list) {
      // Continuation line of the previous list item (wrapped text).
      const last = list.items[list.items.length - 1];
      if (last) {
        last.push({ kind: "text", text: " " });
        last.push(...parseInline(trimmed));
      }
    } else {
      paragraph.push(trimmed);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
