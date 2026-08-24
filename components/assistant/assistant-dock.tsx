"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { Check, ChevronDown, ChevronUp, History, Loader2, MessageCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  askAssistant,
  cancelAssistantAction,
  confirmAssistantAction,
  getAssistantConversation,
  getPendingAssistantActions,
  listAssistantConversations,
  listAssistantTasks,
} from "@/app/assistant/actions";

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

interface PendingAction {
  id: string;
  tool: string;
  summary: string;
  token: string;
}

interface LiveStep {
  tool: string;
  ok?: boolean;
}

interface ConversationSummary {
  id: string;
  title: string;
  lastMessageAt: string | Date | null;
  messageCount: number;
}

interface ReplyPayload {
  conversationId: string;
  reply: string;
  toolCalls: ToolCall[];
  pendingActions?: PendingAction[];
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
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<LiveStep[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [taskLine, setTaskLine] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const conversationId = useRef<string | null>(null);
  const loaded = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Resume the stored conversation once, the first time the panel matters. */
  const loadHistory = () => {
    if (loaded.current) return;
    loaded.current = true;
    void listAssistantTasks().then((result) => {
      if (!result.ok) return;
      const tasks = result.data as Array<{ status: string; undecided: number }>;
      const running = tasks.filter((t) => t.status === "running").length;
      const needYou = tasks.filter((t) => t.undecided > 0).length;
      setTaskLine(
        tasks.length === 0
          ? null
          : `Tasks: ${running} running${needYou > 0 ? ` · ${needYou} need you` : ""}`
      );
    });
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    conversationId.current = stored;
    void getPendingAssistantActions(stored).then((result) => {
      if (result.ok) setPendingActions(result.data as PendingAction[]);
    });
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
  }, [messages, open, pending, busy, steps]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const applyReply = (data: ReplyPayload) => {
    conversationId.current = data.conversationId;
    window.localStorage.setItem(STORAGE_KEY, data.conversationId);
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: data.reply, toolCalls: data.toolCalls },
    ]);
    if (data.pendingActions && data.pendingActions.length > 0) {
      setPendingActions((prev) => [...prev, ...data.pendingActions!]);
    }
  };

  /** The blocking server action — the fallback when streaming is unavailable. */
  const sendViaAction = async (message: string) => {
    const result = await askAssistant({
      conversationId: conversationId.current ?? undefined,
      message,
      pathname,
    });
    if (result.ok) applyReply(result.data as ReplyPayload);
    else setError(result.error.message);
  };

  /** Stream the turn's progress (spec 110): live tool steps, then the reply.
   * Falls back to the server action ONLY if the stream fails before any
   * event arrived — after that the turn may have completed server-side, so
   * a retry could run it twice. */
  const sendViaStream = async (message: string) => {
    let sawEvent = false;
    let settled = false;
    const res = await fetch("/api/assistant/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: conversationId.current ?? undefined,
        message,
        pathname,
      }),
    });
    if (!res.ok || !res.body) throw new Error("stream unavailable");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6)) as
          | { type: "tool_start"; tool: string }
          | { type: "tool_end"; tool: string; ok: boolean }
          | { type: "done"; reply: ReplyPayload }
          | { type: "error"; message: string };
        sawEvent = true;
        if (event.type === "tool_start") {
          setSteps((prev) => [...prev, { tool: event.tool }]);
        } else if (event.type === "tool_end") {
          setSteps((prev) =>
            prev.map((s, i) =>
              i === prev.length - 1 && s.tool === event.tool && s.ok === undefined
                ? { ...s, ok: event.ok }
                : s
            )
          );
        } else if (event.type === "done") {
          settled = true;
          applyReply(event.reply);
        } else {
          settled = true;
          setError(event.message);
        }
      }
    }
    if (!settled) {
      if (sawEvent) setError("The connection dropped mid-answer — reopen the chat to see the saved reply.");
      else throw new Error("stream ended without events");
    }
  };

  const send = () => {
    const message = draft.trim();
    if (!message || pending || busy) return;
    loadHistory();
    setDraft("");
    setError(null);
    setOpen(true);
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setBusy(true);
    setSteps([]);
    void (async () => {
      try {
        await sendViaStream(message);
      } catch {
        await sendViaAction(message);
      } finally {
        setBusy(false);
        setSteps([]);
      }
    })();
  };

  const decide = (action: PendingAction, kind: "confirm" | "cancel") => {
    if (pending || busy) return;
    startTransition(async () => {
      const result =
        kind === "confirm"
          ? await confirmAssistantAction({ token: action.token })
          : await cancelAssistantAction({ token: action.token });
      setPendingActions((prev) => prev.filter((a) => a.id !== action.id));
      if (result.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              kind === "confirm"
                ? `Confirmed and executed: ${action.summary}.`
                : `Dismissed without executing: ${action.summary}.`,
          },
        ]);
      } else {
        setError(result.error.message);
      }
    });
  };

  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) {
      setConversations(null); // loading state
      void listAssistantConversations().then((result) => {
        setConversations(result.ok ? (result.data as ConversationSummary[]) : []);
      });
    }
  };

  const openConversation = (id: string) => {
    if (pending || busy) return;
    setHistoryOpen(false);
    conversationId.current = id;
    window.localStorage.setItem(STORAGE_KEY, id);
    loaded.current = true;
    setMessages([]);
    setPendingActions([]);
    setError(null);
    void getPendingAssistantActions(id).then((result) => {
      if (result.ok) setPendingActions(result.data as PendingAction[]);
    });
    void getAssistantConversation(id).then((result) => {
      if (result.ok) {
        setMessages(
          result.data.map((m) => ({
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
          }))
        );
      }
    });
  };

  const reset = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    conversationId.current = null;
    setMessages([]);
    setPendingActions([]);
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
                {taskLine ?? "answers from live data · consequential actions need your confirm"}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleHistory}
                  aria-label="Previous chats"
                >
                  <History className="size-4" />
                </Button>
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
            {historyOpen && (
              <div className="max-h-48 overflow-y-auto border-b p-1">
                {conversations === null && (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
                )}
                {conversations !== null && conversations.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    No previous chats.
                  </p>
                )}
                {conversations?.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openConversation(c.id)}
                    className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
                  >
                    <span className="min-w-0 flex-1 truncate">{c.title || "Untitled"}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {c.messageCount} msg
                      {c.lastMessageAt
                        ? ` · ${new Date(c.lastMessageAt).toLocaleDateString()}`
                        : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
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
              {pendingActions.map((a) => (
                <div key={a.id} className="rounded-md border border-foreground/25 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Needs your confirmation
                  </p>
                  <p className="mt-1 text-sm">{a.summary}</p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => decide(a, "confirm")} disabled={pending}>
                      Confirm
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => decide(a, "cancel")} disabled={pending}>
                      Dismiss
                    </Button>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Nothing runs until you confirm — the button is bound to this exact
                    action and expires in 15 minutes.
                  </p>
                </div>
              ))}
              {busy && steps.length === 0 && (
                <p className="text-xs text-muted-foreground">Looking things up…</p>
              )}
              {busy && steps.length > 0 && (
                <div className="space-y-0.5">
                  {steps.map((s, i) => (
                    <p
                      key={i}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      {s.ok === undefined ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : s.ok ? (
                        <Check className="size-3" />
                      ) : (
                        <X className="size-3 text-destructive" />
                      )}
                      {s.tool}
                    </p>
                  ))}
                </div>
              )}
              {pending && !busy && (
                <p className="text-xs text-muted-foreground">Working…</p>
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
          disabled={pending || busy}
          className="h-9"
        />
        <Button type="submit" size="sm" disabled={pending || busy || !draft.trim()}>
          {pending || busy ? "…" : "Send"}
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
