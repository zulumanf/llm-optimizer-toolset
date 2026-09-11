/**
 * Streaming transport for the workspace assistant (spec 110). A documented
 * exception to "route handlers only for webhooks/cron" (DECISIONS 2026-08-24):
 * server actions cannot stream, and the mutation semantics live entirely in
 * lib/assistant/service.ts — this route is the same call the server action
 * makes, observed live. The client falls back to the action if this fails.
 */
import { getCurrentUser, type CurrentUser } from "@/lib/auth";
import { askAssistant, type AssistantStreamEvent } from "@/lib/assistant/service";

export async function POST(req: Request): Promise<Response> {
  let user: CurrentUser;
  try {
    user = await getCurrentUser();
  } catch {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }
  const body: unknown = await req.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AssistantStreamEvent | { type: "error"; message: string }): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client went away — the turn still completes and persists.
        }
      };
      try {
        const result = await askAssistant(user, body, undefined, send);
        // The service emits "done" itself; a refusal never emitted one.
        if (!result.ok) send({ type: "error", message: result.error.message });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "The assistant failed unexpectedly.",
        });
      }
      try {
        controller.close();
      } catch {
        // Already closed by a disconnect.
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
