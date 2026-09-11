/**
 * The streaming transport (spec 110) at the HTTP boundary: anonymous
 * requests get 401 before any body work, malformed bodies get 400, and a
 * refusing (or throwing) askAssistant surfaces as exactly one `error` SSE
 * event before the stream closes. Auth and the service are mocked — the
 * route's own behavior is the subject.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { POST } from "@/app/api/assistant/stream/route";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  askAssistant: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/assistant/service", () => ({ askAssistant: mocks.askAssistant }));

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

function request(body: string): Request {
  return new Request("http://test.local/api/assistant/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function sseEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>);
}

describe("POST /api/assistant/stream", () => {
  beforeEach(() => {
    mocks.getCurrentUser.mockReset();
    mocks.askAssistant.mockReset();
  });

  it("refuses an anonymous request with 401 before touching the service", async () => {
    mocks.getCurrentUser.mockRejectedValue(new Error("no session"));
    const res = await POST(request(JSON.stringify({ message: "hi" })));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in." });
    expect(mocks.askAssistant).not.toHaveBeenCalled();
  });

  it("refuses a non-object body with 400 — JSON scalar and unparseable alike", async () => {
    mocks.getCurrentUser.mockResolvedValue(operator);

    const scalar = await POST(request(JSON.stringify("just a string")));
    expect(scalar.status).toBe(400);
    expect(await scalar.json()).toEqual({ error: "Invalid request body." });

    const garbage = await POST(request("not json {{{"));
    expect(garbage.status).toBe(400);
    expect(mocks.askAssistant).not.toHaveBeenCalled();
  });

  it("a refusing askAssistant emits exactly one error SSE event, then the stream closes", async () => {
    mocks.getCurrentUser.mockResolvedValue(operator);
    mocks.askAssistant.mockResolvedValue({
      ok: false,
      error: { kind: "forbidden", message: "The assistant is staff-only." },
    });
    const res = await POST(request(JSON.stringify({ message: "hi" })));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Reading to completion proves the stream closed after the one event.
    const events = await sseEvents(res);
    expect(events).toEqual([{ type: "error", message: "The assistant is staff-only." }]);

    // The service was invoked as the authenticated user with the parsed body.
    expect(mocks.askAssistant).toHaveBeenCalledTimes(1);
    const [user, body, caller, onEvent] = mocks.askAssistant.mock.calls[0] as unknown[];
    expect(user).toEqual(operator);
    expect(body).toEqual({ message: "hi" });
    expect(caller).toBeUndefined();
    expect(typeof onEvent).toBe("function");
  });

  it("a throwing askAssistant also degrades to a single error event", async () => {
    mocks.getCurrentUser.mockResolvedValue(operator);
    mocks.askAssistant.mockRejectedValue(new Error("boom"));
    const res = await POST(request(JSON.stringify({ message: "hi" })));
    const events = await sseEvents(res);
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });
});
