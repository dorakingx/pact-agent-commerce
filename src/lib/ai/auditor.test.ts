import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { asSchema } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AUDITOR_LIMITS,
  AUDITOR_TOOL,
  AuditorUnavailableError,
  auditorCallOptions,
  auditorToolkitConfiguration,
  createOrderReader,
  writeReconciliationStatement,
  type AuditorInput,
  type AuditorModel,
  type AuditorModelRequest,
  type AuditorToolCall,
  type AuditorToolkitOptions,
} from "./auditor";

const ORDER_ID = "5O190127TN364715T";
const CREDENTIALS = { clientId: "sandbox-client-id", clientSecret: "sandbox-client-secret" };

/** PayPal's answer to GET /v2/checkout/orders/{id}, including the personal data PACT must not pass on. */
const PAYPAL_ORDER = {
  id: ORDER_ID,
  intent: "AUTHORIZE",
  status: "COMPLETED",
  payer: {
    name: { given_name: "John", surname: "Doe" },
    email_address: "sb-buyer@personal.example.com",
    payer_id: "QYR5Z8XDVJNXQ",
    address: { country_code: "US" },
  },
  payment_source: { paypal: { email_address: "sb-buyer@personal.example.com", account_id: "QYR5Z8XDVJNXQ" } },
  purchase_units: [
    {
      reference_id: "default",
      amount: { currency_code: "USD", value: "47.00" },
      custom_id: "pact:v1:9f2c",
      invoice_id: "ctr_0000000001",
      shipping: { name: { full_name: "John Doe" }, address: { address_line_1: "1 Main St" } },
      payments: {
        authorizations: [
          {
            id: "0AW2184448108334S",
            status: "CREATED",
            amount: { currency_code: "USD", value: "47.00" },
            expiration_time: "2026-11-04T05:00:00Z",
            seller_protection: { status: "ELIGIBLE" },
          },
        ],
      },
    },
  ],
  links: [{ href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T", rel: "self" }],
};

const FACTS = [
  { field: "Order status", pact: "authorized (expects COMPLETED)", paypal: "COMPLETED", match: true },
  { field: "Order amount", pact: "$47.00", paypal: "$47.00", match: true },
];

const INPUT: AuditorInput = { orderId: ORDER_ID, facts: FACTS, credentials: CREDENTIALS };

interface FakeToolkit {
  createToolkit: (options: AuditorToolkitOptions) => { getTools: () => Record<string, unknown> };
  received: AuditorToolkitOptions[];
  getOrder: ReturnType<typeof vi.fn>;
  others: Record<string, ReturnType<typeof vi.fn>>;
}

/** A toolkit that — unlike the real one under our configuration — also offers tools that move money. */
function fakeToolkit(answer: unknown = JSON.stringify(PAYPAL_ORDER)): FakeToolkit {
  const getOrder = vi.fn(async () => answer);
  const others = { create_order: vi.fn(), pay_order: vi.fn(), create_refund: vi.fn() };
  const received: AuditorToolkitOptions[] = [];
  const parameters = z.object({ id: z.string() });
  const asTool = (execute: unknown) => ({ description: "A PayPal tool.", parameters, execute });
  return {
    received,
    getOrder,
    others,
    createToolkit: (options) => {
      received.push(options);
      return {
        getTools: () => ({
          create_order: asTool(others.create_order),
          get_order: { description: "Retrieves the order details from PayPal for a given order ID.", parameters, execute: getOrder },
          pay_order: asTool(others.pay_order),
          create_refund: asTool(others.create_refund),
        }),
      };
    },
  };
}

/** A model that calls its tool with `ids` (one call each) and then answers with `text`. */
function fakeModel(text: string, ids: unknown[] = [{ id: ORDER_ID }], modelId: string | null = "gemini-2.5-flash") {
  const requests: AuditorModelRequest[] = [];
  const outputs: unknown[] = [];
  const model: AuditorModel = async (request) => {
    requests.push(request);
    for (const input of ids) outputs.push(await request.tool.read(input));
    return { text, modelId };
  };
  return { model, requests, outputs };
}

beforeEach(() => {
  vi.stubEnv("PACT_LOG_SILENT", "1");
  vi.stubEnv("PACT_MODEL_OPS", "google/gemini-2.5-flash");
  vi.stubEnv("PACT_MODEL_FALLBACKS", "openai/gpt-5-mini,google/gemini-2.5-flash");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the auditor's PayPal permissions", () => {
  it("configures the toolkit for one action, reading an order, in the Sandbox", () => {
    expect(auditorToolkitConfiguration()).toEqual({ actions: { orders: { get: true } }, context: { sandbox: true } });
    // A fresh object every time: third-party code receives it and must not be able to widen the next one.
    expect(auditorToolkitConfiguration()).not.toBe(auditorToolkitConfiguration());
  });

  it("makes the real PayPal Agent Toolkit expose get_order and nothing else", () => {
    const toolkit = new PayPalAgentToolkit({ ...CREDENTIALS, configuration: auditorToolkitConfiguration() });
    expect(Object.keys(toolkit.getTools())).toEqual([AUDITOR_TOOL]);
  });

  it("adapts the real toolkit's get_order: its description, and an input schema the AI SDK can send to a model", async () => {
    // No toolkit is injected, so the real one is loaded. The model below never calls the tool:
    // nothing touches the network, and the statement is rejected for that very reason.
    const { model, requests } = fakeModel("A statement written without reading PayPal.", []);
    const rejected = await writeReconciliationStatement(INPUT, { model }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejected).toMatchObject({ reason: "paypal_not_read", toolCalls: [] });

    const [request] = requests;
    expect(request.tool.description).toContain("Retrieves the order details from PayPal");
    expect(await asSchema(request.tool.inputSchema).jsonSchema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
  });

  it("passes exactly that configuration, and the credentials, to the toolkit", async () => {
    const toolkit = fakeToolkit();
    await writeReconciliationStatement(INPUT, { createToolkit: toolkit.createToolkit, model: fakeModel("Matches.").model });
    expect(toolkit.received).toEqual([
      { clientId: CREDENTIALS.clientId, clientSecret: CREDENTIALS.clientSecret, configuration: { actions: { orders: { get: true } }, context: { sandbox: true } } },
    ]);
  });

  it("hands the model only get_order, even when the toolkit offers tools that move money", async () => {
    const toolkit = fakeToolkit();
    const { model, requests } = fakeModel("PayPal holds $47.00 for this order, as PACT recorded.");
    await writeReconciliationStatement(INPUT, { createToolkit: toolkit.createToolkit, model });

    expect(requests).toHaveLength(1);
    expect(requests[0].tool.name).toBe("get_order");
    expect(Object.keys(auditorCallOptions(requests[0]).tools)).toEqual(["get_order"]);
    expect(toolkit.getOrder).toHaveBeenCalledTimes(1);
    for (const other of Object.values(toolkit.others)) expect(other).not.toHaveBeenCalled();
  });
});

describe("createOrderReader", () => {
  function reader(answer: unknown) {
    const execute = vi.fn(async () => answer);
    const calls: AuditorToolCall[] = [];
    return { read: createOrderReader({ execute }, ORDER_ID, calls), execute, calls };
  }

  it("reads the deal's order and returns only what a reconciliation needs", async () => {
    const { read, execute, calls } = reader(JSON.stringify(PAYPAL_ORDER));
    const output = await read({ id: ORDER_ID });

    expect(execute).toHaveBeenCalledWith({ id: ORDER_ID }, {});
    expect(output).toEqual({
      id: ORDER_ID,
      intent: "AUTHORIZE",
      status: "COMPLETED",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: "47.00" },
          custom_id: "pact:v1:9f2c",
          invoice_id: "ctr_0000000001",
          payments: {
            authorizations: [
              { id: "0AW2184448108334S", status: "CREATED", amount: { currency_code: "USD", value: "47.00" }, expiration_time: "2026-11-04T05:00:00Z" },
            ],
          },
        },
      ],
    });
    // The payer's name, e-mail address and postal address never reach the model.
    const seen = JSON.stringify(output);
    for (const personal of ["sb-buyer@personal.example.com", "John", "Doe", "QYR5Z8XDVJNXQ", "1 Main St"]) {
      expect(seen).not.toContain(personal);
    }
    expect(calls).toEqual([{ tool: "get_order", ok: true }]);
  });

  it.each([
    ["another order", { id: "9XY00000AB123456C" }],
    ["a path that escapes the orders endpoint", { id: `${ORDER_ID}/../../../v1/reporting/transactions` }],
    ["a different field", { order_id: ORDER_ID }],
    ["no id", {}],
    ["a non-string id", { id: 42 }],
    ["nothing", null],
  ])("refuses %s without asking PayPal", async (_label, input) => {
    const { read, execute, calls } = reader(JSON.stringify(PAYPAL_ORDER));
    expect(await read(input)).toEqual({ error: `This auditor may only read order ${ORDER_ID}.` });
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toEqual([{ tool: "get_order", ok: false }]);
  });

  it.each([
    ["the toolkit's error envelope", JSON.stringify({ error: { message: "Request failed with status code 404", type: "paypal_error" } })],
    ["text that is not JSON", "<html>Service Unavailable</html>"],
    ["an answer about a different order", JSON.stringify({ ...PAYPAL_ORDER, id: "9XY00000AB123456C" })],
    ["nothing", undefined],
  ])("records a failed read when PayPal answers with %s", async (_label, answer) => {
    const { read, calls } = reader(answer);
    expect(await read({ id: ORDER_ID })).toEqual({ error: "PayPal did not return this order." });
    expect(calls).toEqual([{ tool: "get_order", ok: false }]);
  });

  it("records a failed read when the toolkit throws", async () => {
    const calls: AuditorToolCall[] = [];
    const read = createOrderReader({ execute: () => Promise.reject(new Error("socket hang up")) }, ORDER_ID, calls);
    expect(await read({ id: ORDER_ID })).toEqual({ error: "PayPal could not be read." });
    expect(calls).toEqual([{ tool: "get_order", ok: false }]);
  });

  it("accepts an order the toolkit already parsed, and records every call in order", async () => {
    const { read, calls } = reader(PAYPAL_ORDER);
    await read({ id: "someone-elses-order" });
    await read({ id: ORDER_ID });
    expect(calls).toEqual([
      { tool: "get_order", ok: false },
      { tool: "get_order", ok: true },
    ]);
  });
});

describe("writeReconciliationStatement", () => {
  it("briefs the model with the order id and PACT's side of the ledger only", async () => {
    const { model, requests } = fakeModel("Everything matches.");
    await writeReconciliationStatement(INPUT, { createToolkit: fakeToolkit().createToolkit, model });

    const [request] = requests;
    expect(request.model).toBe("google/gemini-2.5-flash");
    expect(request.fallbackModels).toEqual(["openai/gpt-5-mini"]);
    expect(request.instructions).toContain("You may only read.");
    expect(request.instructions).toContain("Call get_order for the given order id");
    expect(JSON.parse(request.prompt)).toEqual({
      orderId: ORDER_ID,
      pactLedger: [
        { field: "Order status", pact: "authorized (expects COMPLETED)" },
        { field: "Order amount", pact: "$47.00" },
      ],
    });
    // Credentials are for the toolkit; the model never sees them.
    expect(JSON.stringify(request)).not.toContain(CREDENTIALS.clientSecret);
  });

  it("returns the statement as one bounded paragraph with the model and the tool calls", async () => {
    const { model } = fakeModel("  PayPal reports the order as COMPLETED\nwith $47.00 authorized.\n\nThis matches the PACT ledger.  ");
    const statement = await writeReconciliationStatement(INPUT, { createToolkit: fakeToolkit().createToolkit, model });
    expect(statement).toEqual({
      narrative: "PayPal reports the order as COMPLETED with $47.00 authorized. This matches the PACT ledger.",
      model: "google/gemini-2.5-flash",
      toolCalls: [{ tool: "get_order", ok: true }],
    });
  });

  it("cuts a long statement to 600 characters and removes anything that looks like an e-mail address", async () => {
    const long = fakeModel(`The payer sb-buyer@personal.example.com approved. ${"All amounts match. ".repeat(60)}`);
    const statement = await writeReconciliationStatement(INPUT, { createToolkit: fakeToolkit().createToolkit, model: long.model });
    expect(statement.narrative).toHaveLength(AUDITOR_LIMITS.narrativeMaxChars);
    expect(statement.narrative.startsWith("The payer [e-mail removed] approved.")).toBe(true);
    expect(statement.narrative).not.toContain("@");
  });

  it("reports the fallback model when the gateway used it", async () => {
    const viaFallback = fakeModel("Matches.", [{ id: ORDER_ID }], "gpt-5-mini");
    const fallback = await writeReconciliationStatement(INPUT, { createToolkit: fakeToolkit().createToolkit, model: viaFallback.model });
    expect(fallback.model).toBe("openai/gpt-5-mini");

    const unnamed = fakeModel("Matches.", [{ id: ORDER_ID }], null);
    const primary = await writeReconciliationStatement(INPUT, { createToolkit: fakeToolkit().createToolkit, model: unnamed.model });
    expect(primary.model).toBe("google/gemini-2.5-flash");
  });

  async function failure(run: Promise<unknown>): Promise<AuditorUnavailableError> {
    const error = await run.then(
      () => null,
      (caught: unknown) => caught,
    );
    if (!(error instanceof AuditorUnavailableError)) throw new Error("expected an AuditorUnavailableError");
    return error;
  }

  it("is unavailable when the toolkit cannot be created or has no usable get_order", async () => {
    const { model, requests } = fakeModel("Matches.");
    const broken = await failure(
      writeReconciliationStatement(INPUT, {
        createToolkit: () => {
          throw new Error("Cannot find module");
        },
        model,
      }),
    );
    expect(broken.reason).toBe("toolkit");

    const empty = await failure(writeReconciliationStatement(INPUT, { createToolkit: () => ({ getTools: () => ({}) }), model }));
    expect(empty.reason).toBe("toolkit");

    const malformed = await failure(
      writeReconciliationStatement(INPUT, {
        createToolkit: () => ({ getTools: () => ({ get_order: { description: "x", parameters: {}, execute: "not a function" } }) }),
        model,
      }),
    );
    expect(malformed.reason).toBe("toolkit");
    // Without a tool there is nothing to ask the model.
    expect(requests).toHaveLength(0);
  });

  it("is unavailable when the model call fails, and still reports the reads that happened", async () => {
    const timeout: AuditorModel = async (request) => {
      await request.tool.read({ id: ORDER_ID });
      throw new Error("The operation was aborted due to timeout");
    };
    const error = await failure(writeReconciliationStatement(INPUT, { createToolkit: fakeToolkit().createToolkit, model: timeout }));
    expect(error.reason).toBe("model");
    expect(error.toolCalls).toEqual([{ tool: "get_order", ok: true }]);
  });

  it("rejects a statement from a model that never read PayPal successfully", async () => {
    const noCall = fakeModel("Everything matches perfectly.", []);
    const silent = await failure(writeReconciliationStatement(INPUT, { createToolkit: fakeToolkit().createToolkit, model: noCall.model }));
    expect(silent.reason).toBe("paypal_not_read");
    expect(silent.toolCalls).toEqual([]);

    const wrongOrder = fakeModel("Everything matches perfectly.", [{ id: "9XY00000AB123456C" }]);
    const refused = await failure(writeReconciliationStatement(INPUT, { createToolkit: fakeToolkit().createToolkit, model: wrongOrder.model }));
    expect(refused.reason).toBe("paypal_not_read");
    expect(refused.toolCalls).toEqual([{ tool: "get_order", ok: false }]);

    const paypalDown = fakeToolkit(JSON.stringify({ error: { message: "503", type: "paypal_error" } }));
    const unread = await failure(
      writeReconciliationStatement(INPUT, { createToolkit: paypalDown.createToolkit, model: fakeModel("Everything matches.").model }),
    );
    expect(unread.reason).toBe("paypal_not_read");
  });

  it("rejects an empty statement", async () => {
    const blank = fakeModel(" \n\t ");
    const error = await failure(writeReconciliationStatement(INPUT, { createToolkit: fakeToolkit().createToolkit, model: blank.model }));
    expect(error.reason).toBe("empty_statement");
    expect(error.toolCalls).toEqual([{ tool: "get_order", ok: true }]);
  });
});

describe("auditorCallOptions", () => {
  it("builds a call with one tool, a step limit, a hard timeout and the gateway fallbacks", async () => {
    const read = vi.fn(async () => ({ id: ORDER_ID, status: "COMPLETED" }));
    const request: AuditorModelRequest = {
      model: "google/gemini-2.5-flash",
      fallbackModels: ["openai/gpt-5-mini"],
      instructions: "You may only read.",
      prompt: "{}",
      tool: { name: "get_order", description: "Reads an order.", inputSchema: z.object({ id: z.string() }), read },
    };
    const options = auditorCallOptions(request);

    expect(options).toMatchObject({
      model: "google/gemini-2.5-flash",
      instructions: "You may only read.",
      prompt: "{}",
      timeout: { totalMs: 20_000 },
      maxRetries: 1,
      providerOptions: {
        gateway: { models: ["openai/gpt-5-mini"] },
        openai: { reasoningEffort: "minimal" },
        google: { thinkingConfig: { thinkingBudget: 0 } },
      },
    });
    expect(AUDITOR_LIMITS).toMatchObject({ maxSteps: 3, totalTimeoutMs: 20_000, maxRetries: 1 });
    expect(typeof options.stopWhen).toBe("function");
    expect(Object.keys(options.tools)).toEqual(["get_order"]);
    expect(options.tools.get_order.description).toBe("Reads an order.");

    // The SDK tool is a thin shell around the guarded reader.
    const output = await options.tools.get_order.execute({ id: ORDER_ID }, { toolCallId: "call_1", messages: [], context: {} });
    expect(read).toHaveBeenCalledWith({ id: ORDER_ID });
    expect(output).toEqual({ id: ORDER_ID, status: "COMPLETED" });
  });
});
