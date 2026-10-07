/**
 * The dashboard's LLM proxy (POST /api/ops/ai) called directly with Request objects.
 *
 * Replaced: the cookie store Next.js would provide, the service context (one test database, so
 * the rate limit is real), the Vercel OIDC lookup, and global `fetch` — the stand-in for the AI
 * Gateway, which records exactly what the route would have sent upstream. Everything else is the
 * real code, so each property the route promises is checked on what crosses its two boundaries.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgents } from "@/lib/ai";
import type { ApiErrorBody } from "@/lib/api/dto";
import { OPS_AI_DEFAULT_MODEL, OPS_AI_RATE_LIMIT, type OpsAiStatus } from "@/lib/client/studio-ai-contract";
import { closeDb, createDbSimulatedStore, createTestDb, type Db } from "@/lib/db";
import { SimulatedProvider } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { SESSION_COOKIE } from "@/lib/services/session";

const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  ctx: null as unknown,
  oidc: null as string | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined),
    set: (name: string, value: string) => {
      state.cookies.set(name, value);
    },
  }),
}));

vi.mock("@/lib/services/context", () => ({
  getServiceContext: async () => state.ctx,
}));

vi.mock("@vercel/functions/oidc", () => ({
  getVercelOidcToken: async () => {
    if (state.oidc === null) throw new Error("No OIDC token in this environment");
    return state.oidc;
  },
}));

import { GET, POST, maxDuration } from "@/app/api/ops/ai/route";

const ORIGIN = "https://pact.test";
const GATEWAY = "https://ai-gateway.vercel.sh/v1/responses";
const API_KEY = "gw-test-key-000000000000";
const SECRET_PROMPT = "PROMPT-CANARY-7f3a: which deals need a human?";

let db: Db;
let nowMs = Date.parse("2026-10-06T05:00:00.000Z");
const now = (): Date => new Date(nowMs);
const upstream = vi.fn<typeof fetch>();

beforeAll(async () => {
  db = await createTestDb();
  const ctx: ServiceContext = { db, agents: createAgents({ mode: "scripted" }), provider: new SimulatedProvider(createDbSimulatedStore(db), { now }), now };
  state.ctx = ctx;
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(() => {
  state.cookies.clear();
  state.oidc = null;
  // A fresh rate-limit window for every test.
  nowMs += 3_600_000;
  upstream.mockReset();
  upstream.mockImplementation(async () => Response.json({ id: "resp_1", status: "completed", output: [] }));
  vi.stubGlobal("fetch", upstream);
  vi.stubEnv("AI_GATEWAY_API_KEY", API_KEY);
  vi.stubEnv("PACT_AI_MODE", "ai");
  vi.stubEnv("PACT_LOG_SILENT", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Json = Record<string, unknown>;

function turn(overrides: Json = {}): Json {
  return {
    model: "openai/gpt-5-mini",
    stream: true,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: SECRET_PROMPT }] }],
    ...overrides,
  };
}

function post(body: Json | string, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(`${ORIGIN}/api/ops/ai`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    {},
  );
}

async function errorOf(response: Response): Promise<ApiErrorBody["error"]> {
  return ((await response.json()) as ApiErrorBody).error;
}

/** What the route sent to the gateway on its nth call. */
function sent(call = 0): { url: string; headers: Headers; body: Json; init: RequestInit } {
  const [url, init] = upstream.mock.calls[call]!;
  return { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Json, init: init ?? {} };
}

describe("POST /api/ops/ai — what goes upstream", () => {
  it("forwards the turn to the AI Gateway with PACT's key", async () => {
    const response = await post(turn({ instructions: "Be brief." }));
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const { url, headers, body, init } = sent();
    expect(url).toBe(GATEWAY);
    expect(init.method).toBe("POST");
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(body).toMatchObject({ model: "openai/gpt-5-mini", stream: true, store: false, instructions: "Be brief." });
    expect(body.input).toEqual(turn().input);
  });

  it("uses the deployment's OIDC token when no gateway key is configured", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    state.oidc = "oidc-token-for-this-deployment";
    expect((await post(turn())).status).toBe(200);
    expect(sent().headers.get("authorization")).toBe("Bearer oidc-token-for-this-deployment");
  });

  it("replaces any credential the client sends, in a header or in the body", async () => {
    await post(turn({ authorization: "Bearer stolen", api_key: "sk-client", headers: { authorization: "Bearer stolen" } }), {
      authorization: "Bearer client-supplied",
      "x-api-key": "sk-client",
      cookie: "other=1",
    });
    const { headers, body } = sent();
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect([...headers.keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(JSON.stringify(body)).not.toMatch(/stolen|sk-client|client-supplied/);
  });

  it("answers on the default model when the client names one outside the allow-list", async () => {
    for (const model of ["openai/gpt-5", "anthropic/claude-opus-4", "", undefined, 42, { id: "openai/gpt-5-mini" }]) {
      await post(turn({ model }));
    }
    expect(upstream.mock.calls.map((_, index) => sent(index).body.model)).toEqual(Array(6).fill(OPS_AI_DEFAULT_MODEL));
    await post(turn({ model: "google/gemini-2.5-flash" }));
    expect(sent(6).body.model).toBe("google/gemini-2.5-flash");
  });

  it("caps the output budget whatever the client asks for", async () => {
    await post(turn({ max_output_tokens: 1_000_000 }));
    await post(turn({ max_output_tokens: 512 }));
    await post(turn({ max_output_tokens: -5 }));
    await post(turn());
    expect(upstream.mock.calls.map((_, index) => sent(index).body.max_output_tokens)).toEqual([4096, 512, 4096, 4096]);
  });

  it("forwards only the fields it knows: no stored conversations, metadata or provider options", async () => {
    await post(
      turn({
        store: true,
        previous_response_id: "resp_someone_elses",
        metadata: { user: "x" },
        user: "someone",
        service_tier: "priority",
        background: true,
        reasoning: { effort: "high", summary: "detailed" },
        text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } }, verbosity: "high" },
      }),
    );
    const { body } = sent();
    expect(Object.keys(body).sort()).toEqual(["input", "max_output_tokens", "model", "reasoning", "store", "stream", "text"]);
    expect(body.store).toBe(false);
    // An effort outside the allowed set falls back to the default; a summary of reasoning is never requested.
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.text).toEqual({ format: { type: "json_schema", name: "answer", schema: { type: "object" } } });
  });

  it("keeps function tools and drops provider-hosted ones", async () => {
    const explain = { type: "function", name: "explain_deal", description: "Explain a deal", parameters: { type: "object" }, strict: false };
    await post(turn({ tools: [explain, { type: "web_search" }, { type: "code_interpreter", container: { type: "auto" } }, "nonsense"], tool_choice: { type: "function", name: "explain_deal" } }));
    expect(sent().body.tools).toEqual([explain]);
    expect(sent().body.tool_choice).toEqual({ type: "function", name: "explain_deal" });

    await post(turn({ tools: [{ type: "web_search" }], tool_choice: "required" }));
    expect(sent(1).body).not.toHaveProperty("tools");
    expect(sent(1).body).not.toHaveProperty("tool_choice");

    await post(turn({ tools: [explain], tool_choice: { type: "web_search" } }));
    expect(sent(2).body).not.toHaveProperty("tool_choice");
  });

  it("times the upstream call out and ties it to the caller's connection", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await post(turn());
    expect(timeout).toHaveBeenCalledWith(55_000);
    expect(sent().init.signal).toBeInstanceOf(AbortSignal);
    expect(maxDuration).toBe(60);
  });
});

describe("POST /api/ops/ai — what comes back", () => {
  it("passes a server-sent event stream straight through, chunk by chunk", async () => {
    const chunks = ['data: {"type":"response.created"}\n\n', 'data: {"type":"response.output_text.delta","delta":"Hel', 'lo"}\n\n', "data: [DONE]\n\n"];
    upstream.mockImplementation(async () => {
      const encoder = new TextEncoder();
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index === chunks.length) return controller.close();
          controller.enqueue(encoder.encode(chunks[index++]!));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "x-upstream-secret": "do-not-forward" } });
    });

    const response = await post(turn());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("x-upstream-secret")).toBeNull();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const received: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(decoder.decode(value));
    }
    expect(received).toEqual(chunks);
  });

  it("passes a non-streamed JSON answer through unchanged", async () => {
    const answer = { id: "resp_9", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ready" }] }] };
    upstream.mockImplementation(async () => Response.json(answer));
    const response = await post(turn({ stream: false }));
    expect(sent().body.stream).toBe(false);
    expect(sent().headers.get("accept")).toBe("application/json");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(answer);
  });

  it("turns a provider failure into the API's own error, with the provider's sentence but not its body", async () => {
    upstream.mockImplementation(async () => Response.json({ error: { message: "Invalid schema for function 'configure_widget'.", internal: "trace-1234" } }, { status: 400 }));
    const response = await post(turn());
    expect(response.status).toBe(503);
    const error = await errorOf(response);
    expect(error.code).toBe("unavailable");
    expect(error.message).toBe("The AI provider could not answer this request (400). Invalid schema for function 'configure_widget'.");
    expect(JSON.stringify(error)).not.toContain("trace-1234");
    expect(error.requestId).toBe(response.headers.get("x-request-id"));
  });

  it("says so when the provider is rate limiting, unreachable or too slow", async () => {
    upstream.mockImplementationOnce(async () => new Response("slow down", { status: 429 }));
    expect((await errorOf(await post(turn()))).message).toBe("The AI provider is rate limiting PACT right now. Try again in a moment.");

    upstream.mockImplementationOnce(async () => Promise.reject(new TypeError("fetch failed")));
    const unreachable = await post(turn());
    expect(unreachable.status).toBe(503);
    expect((await errorOf(unreachable)).message).toBe("The AI provider could not be reached. Try again.");

    upstream.mockImplementationOnce(async () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));
    expect((await errorOf(await post(turn()))).message).toBe("The AI provider did not answer in time. Try again.");
  });
});

describe("POST /api/ops/ai — what it refuses", () => {
  it("refuses cross-site requests before anything else happens", async () => {
    const attempts: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { origin: "not a url" }];
    for (const headers of attempts) {
      const response = await post(turn(), headers);
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("forbidden");
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(state.cookies.size).toBe(0);
  });

  it("refuses a body over the size cap, declared or not", async () => {
    const big = JSON.stringify(turn({ instructions: "x".repeat(400_001) }));

    const declared = await post(big, { "content-length": String(Buffer.byteLength(big)) });
    expect(declared.status).toBe(400);
    expect(await errorOf(declared)).toMatchObject({ code: "invalid_request", message: "Request body is too large" });

    // No Content-Length (a chunked upload): the cap is enforced while the body is read.
    const undeclared = await post(big);
    expect(undeclared.status).toBe(400);
    expect((await errorOf(undeclared)).message).toBe("Request body is too large");

    expect(upstream).not.toHaveBeenCalled();

    // Just under the cap is accepted.
    const padding = 400_000 - Buffer.byteLength(JSON.stringify(turn({ instructions: "" })));
    expect((await post(turn({ instructions: "x".repeat(padding) }))).status).toBe(200);
  });

  it("refuses anything that is not a JSON turn", async () => {
    const cases: [string | Json, Record<string, string>, string][] = [
      [JSON.stringify(turn()), { "content-type": "text/plain" }, "Content-Type must be application/json"],
      ["{not json", {}, "Request body is not valid JSON"],
      ["[1,2,3]", {}, "Request body must be a JSON object"],
      [{ model: "openai/gpt-5-mini" }, {}, "`input` is required"],
      [turn({ input: { role: "user" } }), {}, "`input` is required"],
    ];
    for (const [body, headers, message] of cases) {
      const response = await post(body, headers);
      expect(response.status, message).toBe(400);
      expect((await errorOf(response)).message).toBe(message);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers with a clean error, and calls no model, when the deployment runs scripted agents", async () => {
    vi.stubEnv("PACT_AI_MODE", "scripted");
    const response = await post(turn());
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({
      code: "unavailable",
      message: "The dashboard agents are switched off: this deployment runs scripted agents and calls no model.",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(upstream).not.toHaveBeenCalled();
    // Refused before a session is started or a rate-limit counter is touched.
    expect(state.cookies.size).toBe(0);
  });

  it("answers with a clean error when no gateway credential exists", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const response = await post(turn());
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toBe(
      "The dashboard agents are switched off: no AI Gateway credentials are configured on this deployment.",
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("allows thirty turns per session in ten minutes, then says when to come back", async () => {
    for (let call = 0; call < OPS_AI_RATE_LIMIT.limit; call += 1) expect((await post(turn())).status).toBe(200);
    // The first call started the session; every later one was counted against it.
    expect(state.cookies.has(SESSION_COOKIE)).toBe(true);

    const refused = await post(turn());
    expect(refused.status).toBe(429);
    expect((await errorOf(refused)).code).toBe("rate_limited");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(upstream).toHaveBeenCalledTimes(OPS_AI_RATE_LIMIT.limit);

    // Another session is not affected...
    state.cookies.clear();
    expect((await post(turn())).status).toBe(200);
    // ...and the first one is served again once its window has passed.
    nowMs += (OPS_AI_RATE_LIMIT.windowSeconds + 1) * 1000;
    expect((await post(turn())).status).toBe(200);
  });
});

describe("POST /api/ops/ai — what it keeps to itself", () => {
  it("never logs a request body, a prompt or a credential", async () => {
    vi.stubEnv("PACT_LOG_SILENT", "");
    const lines: string[] = [];
    const capture = (...args: unknown[]): void => void lines.push(args.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);

    await post(turn({ instructions: "INSTRUCTION-CANARY-91c2" }));
    upstream.mockImplementationOnce(async () => Response.json({ error: { message: "upstream said no" } }, { status: 500 }));
    await post(turn({ instructions: "INSTRUCTION-CANARY-91c2" }));

    const log = lines.join("\n");
    expect(log).toContain("ops.ai");
    expect(log).toContain("openai/gpt-5-mini");
    expect(log).not.toContain("PROMPT-CANARY-7f3a");
    expect(log).not.toContain("INSTRUCTION-CANARY-91c2");
    expect(log).not.toContain(API_KEY);
  });
});

describe("GET /api/ops/ai", () => {
  const status = async (): Promise<{ response: Response; body: OpsAiStatus }> => {
    const response = await GET(new Request(`${ORIGIN}/api/ops/ai`), {});
    return { response, body: (await response.json()) as OpsAiStatus };
  };

  it("reports the agents as available with the models on offer, starting no session", async () => {
    const { response, body } = await status();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      available: true,
      reason: null,
      message: null,
      models: [
        { id: "openai/gpt-5-mini", label: "GPT-5 mini" },
        { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      ],
      defaultModel: "openai/gpt-5-mini",
    });
    expect(state.cookies.size).toBe(0);
    expect(upstream).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("explains why the agents are off: scripted mode, or no credential", async () => {
    vi.stubEnv("PACT_AI_MODE", "scripted");
    expect((await status()).body).toMatchObject({ available: false, reason: "scripted", message: expect.stringContaining("scripted agents") });

    vi.stubEnv("PACT_AI_MODE", "ai");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    expect((await status()).body).toMatchObject({ available: false, reason: "no_credentials", message: expect.stringContaining("no AI Gateway credentials") });

    state.oidc = "oidc-token";
    expect((await status()).body.available).toBe(true);
  });
});
