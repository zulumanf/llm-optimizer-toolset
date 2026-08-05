/**
 * Renders a captured answer with the assistant's own formatting (spec 048
 * round 4b): bold as bold, lists as lists, links as links — what the
 * asker's screen actually showed, instead of the markdown control marks.
 * Builds React elements from the typed AST only; untrusted text never
 * reaches the DOM as HTML.
 */
import {
  parseTranscript,
  type BlockNode,
  type InlineNode,
} from "@/lib/prospects/transcript-format";

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === "text") return <span key={i}>{node.text}</span>;
        if (node.kind === "bold") {
          return (
            <strong key={i} className="font-semibold text-foreground">
              <Inline nodes={node.children} />
            </strong>
          );
        }
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noreferrer nofollow"
            className="underline underline-offset-2 transition-colors hover:text-muted-foreground"
          >
            <Inline nodes={node.children} />
          </a>
        );
      })}
    </>
  );
}

function Block({ block }: { block: BlockNode }) {
  if (block.kind === "heading") {
    return (
      <p className="text-sm font-semibold">
        <Inline nodes={block.children} />
      </p>
    );
  }
  if (block.kind === "ordered-list" || block.kind === "bullet-list") {
    const List = block.kind === "ordered-list" ? "ol" : "ul";
    return (
      <List
        className={`space-y-1.5 pl-5 ${
          block.kind === "ordered-list" ? "list-decimal" : "list-disc"
        }`}
      >
        {block.items.map((item, i) => (
          <li key={i}>
            <Inline nodes={item} />
          </li>
        ))}
      </List>
    );
  }
  return (
    <p>
      <Inline nodes={block.children} />
    </p>
  );
}

export function TranscriptAnswer({ text }: { text: string }) {
  const blocks = parseTranscript(text);
  return (
    <div className="mt-2 max-w-[65ch] space-y-3 text-sm leading-relaxed text-foreground">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
