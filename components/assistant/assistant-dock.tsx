"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronUp, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { askAssistant, getAssistantConversation } from "@/app/assistant/actions";

const STORAGE_KEY = "avos-assistant-conversation";

interface ToolCall {
  tool: string;
  ok: boolean;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

/**
 * The always-present assistant bar (spec 044): a composer docked at the
 * bottom of the workspace like ChatGPT/Claude — the input is always there;
 * the transcript opens as a panel above it on send or toggle.
 */
export function AssistantDock() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const conversationId = useRef<string | null>(null);
  const loaded = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Resume the stored conversation once, the first time the panel matters. */
  const loadHistory = () => {
    if (loaded.current) return;
    loaded.current = true;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    conversationId.current = stored;
    void getAssistantConversation(stored).then((result) => {
      if (result.ok) {
        setMessages(
          result.data.map((m) => ({
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
          }))
        );
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
        conversationId.current = null;
      }
    });
  };

  useEffect(() => {
    if (open) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages, open, pending]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const send = () => {
    const message = draft.trim();
    if (!message || pending) return;
    loadHistory();
    setDraft("");
    setError(null);
    setOpen(true);
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    startTransition(async () => {
      const result = await askAssistant({
        conversationId: conversationId.current ?? undefined,
        message,
        pathname,
      });
      if (result.ok) {
        const data = result.data as {
          conversationId: string;
          reply: string;
          toolCalls: ToolCall[];
        };
        conversationId.current = data.conversationId;
        window.localStorage.setItem(STORAGE_KEY, data.conversationId);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.reply, toolCalls: data.toolCalls },
        ]);
      } else {
        setError(result.error.message);
      }
    });
  };

  const reset = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    conversationId.current = null;
    setMessages([]);
    setError(null);
  };

  return (
    <div className="relative border-t bg-background">
      {open && (
        <div className="absolute bottom-full left-1/2 z-40 w-full max-w-3xl -translate-x-1/2 px-4">
          <div className="flex h-[26rem] max-h-[60vh] flex-col rounded-t-lg border border-b-0 bg-background shadow-xl">
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <MessageCircle className="size-4" />
              <span className="text-sm font-medium">AVOS assistant</span>
              <span className="text-xs text-muted-foreground">
                read-only · answers from live data
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={reset}>
                  New chat
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                  aria-label="Collapse transcript"
                >
                  <ChevronDown className="size-4" />
                </Button>
              </div>
            </div>
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
              {messages.length === 0 && (
                <p className="text-muted-foreground">
                  Ask about anything in the workspace — visibility scores, prospects,
                  gaps, citations. Every number comes from a platform lookup, shown
                  under each answer.
                </p>
              )}
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "text-right" : ""}>
                  <div
                    className={
                      m.role === "user"
                        ? "inline-block max-w-[85%] rounded-lg bg-primary px-3 py-1.5 text-left text-primary-foreground"
                        : "inline-block max-w-[90%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-1.5"
                    }
                  >
                    {m.content}
                  </div>
                  {m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      looked up:{" "}
                      {m.toolCalls!
                        .map((t) => `${t.tool}${t.ok ? "" : " (failed)"}`)
                        .join(", ")}
                    </p>
                  )}
                </div>
              ))}
              {pending && (
                <p className="text-xs text-muted-foreground">Looking things up…</p>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          </div>
        </div>
      )}

      <form
        className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <MessageCircle className="size-4 shrink-0 text-muted-foreground" />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={loadHistory}
          placeholder="Ask AVOS about this workspace…"
          disabled={pending}
          className="h-9"
        />
        <Button type="submit" size="sm" disabled={pending || !draft.trim()}>
          {pending ? "…" : "Send"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            loadHistory();
            setOpen((v) => !v);
          }}
          aria-label={open ? "Collapse transcript" : "Expand transcript"}
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </Button>
      </form>
    </div>
  );
}
