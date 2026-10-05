/**
 * System status when something is wrong (the cases that need no database), and the published
 * API description: public/openapi.json must describe exactly the routes that exist and the
 * shapes the code returns. Status with a healthy database is covered in
 * tests/integration/ops-routes.test.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconciliationView, WalletStatus } from "@/lib/api/dto";
import { APP_VERSION } from "@/lib/config";
import type { Db, DealGraph } from "@/lib/db";
import {
  AUDIT_ACTORS,
  AUDIT_EVENT_TYPES,
  ASPECT_RATIOS,
  AuditEventSchema,
  CATEGORIES,
  ContractSchema,
  CopyArtifactSchema,
  CopySpecSchema,
  HumanDecisionKindSchema,
  HumanDecisionSchema,
  IllustrationArtifactSchema,
  IllustrationSpecSchema,
  LANGUAGES,
  MandateSchema,
  NegotiationMoveSchema,
  PolicyCheckSchema,
  PolicyEvaluationSchema,
  PolicySchema,
  SettlementTermsSchema,
  SignedContractSchema,
  SubmissionSchema,
  TermsSchema,
  VERIFICATION_RULE_KINDS,
  VerificationCheckSchema,
  VerificationDecisionSchema,
  VerificationReportSchema,
  VerificationRuleSchema,
} from "@/lib/domain/schemas";
import { SCENARIOS } from "@/lib/domain/scenarios";
import { SELLERS, toSellerPublic } from "@/lib/domain/sellers";
import { DEAL_STATUSES, PAYMENT_STATUSES } from "@/lib/domain/status";
import { newPaymentRecord } from "@/lib/payments";
import { buildDealView, toDealSummary } from "./deal-view";
import { getSystemStatus } from "./system";

/* -------------------------------------------------------------------------- */
/*  System status                                                              */
/* -------------------------------------------------------------------------- */

const SECRETS = {
  clientId: "AZ-sandbox-client-id-0000000000",
  clientSecret: "EL-sandbox-client-secret-11111",
  webhookId: "WH-22222222222222222",
  adminToken: "operator-token-3333",
  sessionSecret: "session-secret-4444",
  databaseUrl: "postgres://pact:database-password-5555@db.example.com/pact",
};

const databaseDown = (): Promise<Db> => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432"));

describe("getSystemStatus without a reachable database", () => {
  beforeEach(() => {
    vi.stubEnv("PACT_LOG_SILENT", "1");
    for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_API_BASE", "PACT_PAYMENT_MODE", "PACT_AI_MODE", "DATABASE_URL", "POSTGRES_URL"]) {
      vi.stubEnv(name, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("still answers, reporting what is known and that the database is degraded", async () => {
    const status = await getSystemStatus({ openDb: databaseDown });
    expect(status).toEqual({
      payments: { provider: "simulated", configured: false, webhooks: false, delegatedWallet: false },
      ai: {
        mode: "ai",
        buyerModel: "google/gemini-2.5-flash",
        sellerModel: "openai/gpt-5-mini",
        verifierModel: "google/gemini-2.5-flash",
      },
      database: "pglite",
      version: APP_VERSION,
      degraded: ["database"],
    });
  });

  it("does not wait for a database that never answers", async () => {
    const started = Date.now();
    const status = await getSystemStatus({ openDb: () => new Promise<Db>(() => {}), dbTimeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(status.degraded).toEqual(["database"]);
    expect(status.payments.delegatedWallet).toBe(false);
  });

  it("reports the configured integrations and never their values", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", SECRETS.clientId);
    vi.stubEnv("PAYPAL_CLIENT_SECRET", SECRETS.clientSecret);
    vi.stubEnv("PAYPAL_WEBHOOK_ID", SECRETS.webhookId);
    vi.stubEnv("ADMIN_TOKEN", SECRETS.adminToken);
    vi.stubEnv("SESSION_SECRET", SECRETS.sessionSecret);
    vi.stubEnv("DATABASE_URL", SECRETS.databaseUrl);
    vi.stubEnv("PACT_AI_MODE", "scripted");
    vi.stubEnv("PACT_MODEL_BUYER", "anthropic/claude-haiku-4.5");

    const status = await getSystemStatus({ openDb: databaseDown });
    expect(status).toMatchObject({
      payments: { provider: "paypal_sandbox", configured: true, webhooks: true, delegatedWallet: false },
      ai: { mode: "scripted", buyerModel: "anthropic/claude-haiku-4.5" },
      database: "postgres",
    });
    const published = JSON.stringify(status);
    for (const secret of [...Object.values(SECRETS), "database-password-5555", "db.example.com"]) {
      expect(published).not.toContain(secret);
    }
  });

  it("says credentials are configured but no webhook id is", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", SECRETS.clientId);
    vi.stubEnv("PAYPAL_CLIENT_SECRET", SECRETS.clientSecret);
    expect((await getSystemStatus({ openDb: databaseDown })).payments).toMatchObject({
      provider: "paypal_sandbox",
      configured: true,
      webhooks: false,
    });
  });

  it("keeps the simulator label when it is forced although credentials exist", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", SECRETS.clientId);
    vi.stubEnv("PAYPAL_CLIENT_SECRET", SECRETS.clientSecret);
    vi.stubEnv("PACT_PAYMENT_MODE", "simulated");
    expect((await getSystemStatus({ openDb: databaseDown })).payments).toMatchObject({ provider: "simulated", configured: true });
  });

  it("reports a PayPal configuration that points away from the Sandbox as degraded, without throwing", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", SECRETS.clientId);
    vi.stubEnv("PAYPAL_CLIENT_SECRET", SECRETS.clientSecret);
    vi.stubEnv("PAYPAL_API_BASE", "https://api-m.paypal.com");
    const status = await getSystemStatus({ openDb: databaseDown });
    expect(status.payments).toEqual({ provider: "paypal_sandbox", configured: false, webhooks: false, delegatedWallet: false });
    expect(status.degraded).toEqual(["database", "payments"]);
  });
});

/* -------------------------------------------------------------------------- */
/*  public/openapi.json                                                        */
/* -------------------------------------------------------------------------- */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const ROOT = process.cwd();
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: Json | undefined, ...keys: string[]): JsonObject {
  let current: Json | undefined = value;
  for (const key of keys) current = isObject(current) ? current[key] : undefined;
  if (!isObject(current)) throw new Error(`openapi.json has no object at ${keys.join(".")}`);
  return current;
}

const spec = JSON.parse(readFileSync(path.join(ROOT, "public", "openapi.json"), "utf8")) as JsonObject;
const schemas = at(spec, "components", "schemas");
const paths = at(spec, "paths");

function operations(): { path: string; method: string; operation: JsonObject }[] {
  return Object.entries(paths).flatMap(([route, item]) =>
    HTTP_METHODS.filter((method) => isObject(item) && method in item).map((method) => ({
      path: route,
      method,
      operation: at(item, method),
    })),
  );
}

/** Property names of an object schema, with the required ones. */
function shape(schema: Json | undefined): { properties: string[]; required: string[] } {
  const object = at(schema);
  const required = Array.isArray(object.required) ? object.required.map(String) : [];
  return { properties: Object.keys(at(object, "properties")).sort(), required: required.sort() };
}

function enumOf(name: string): Json[] {
  const values = at(schemas, name).enum;
  if (!Array.isArray(values)) throw new Error(`${name} is not an enum`);
  return values;
}

/** Every `$ref` in the document, wherever it occurs. */
function references(value: Json, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => references(item, found));
  else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") found.push(child);
      else references(child, found);
    }
  }
  return found;
}

/** The route handlers that exist: `/api/deals/[id]/route.ts` exporting GET → "GET /api/deals/{id}". */
function implementedOperations(): string[] {
  const apiRoot = path.join(ROOT, "src", "app", "api");
  const files = readdirSync(apiRoot, { recursive: true, encoding: "utf8" }).filter((file) => path.basename(file) === "route.ts");
  return files
    .flatMap((file) => {
      const route = `/api/${path.dirname(file).split(path.sep).join("/")}`.replace(/\[([^\]]+)\]/g, "{$1}");
      const source = readFileSync(path.join(apiRoot, file), "utf8");
      return [...source.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm)].map((match) => `${match[1]} ${route}`);
    })
    .sort();
}

describe("public/openapi.json", () => {
  it("is an OpenAPI 3.1 document for this version of PACT", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(at(spec, "info")).toMatchObject({ title: expect.stringContaining("PACT"), version: APP_VERSION });
    expect(Object.keys(at(spec, "components", "securitySchemes")).sort()).toEqual(["adminToken", "session"]);
    expect(at(spec, "components", "securitySchemes", "session")).toMatchObject({ type: "apiKey", in: "cookie", name: "pact_sid" });
    expect(at(spec, "components", "securitySchemes", "adminToken")).toMatchObject({ type: "apiKey", in: "header", name: "x-admin-token" });
  });

  it("describes every route of the public API", () => {
    const documented = operations().map(({ path: route, method }) => `${method.toUpperCase()} ${route}`).sort();
    expect(documented).toEqual(
      [
        "POST /api/deals",
        "GET /api/deals",
        "GET /api/deals/{id}",
        "POST /api/deals/{id}/advance",
        "POST /api/deals/{id}/decision",
        "GET /api/deals/{id}/artifacts/{artifactId}",
        "POST /api/deals/{id}/reconcile",
        "GET /api/operations",
        "GET /api/policy",
        "PUT /api/policy",
        "GET /api/wallet",
        "DELETE /api/wallet",
        "POST /api/wallet/connect",
        "GET /api/health",
        "POST /api/webhooks/paypal",
        "GET /api/paypal/return",
        "GET /api/paypal/cancel",
        "GET /api/paypal/vault-return",
        "POST /api/simulated/approve",
        "POST /api/simulated/cancel",
      ].sort(),
    );
  });

  it("describes exactly the route handlers that exist: none missing, none invented", () => {
    const documented = operations().map(({ path: route, method }) => `${method.toUpperCase()} ${route}`).sort();
    expect(documented).toEqual(implementedOperations());
  });

  it("gives every operation a unique id, a tag, a summary and at least one response", () => {
    const ids = operations().map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const tags = (Array.isArray(spec.tags) ? spec.tags : []).map((tag) => (isObject(tag) ? tag.name : null));
    for (const { path: route, method, operation } of operations()) {
      const label = `${method} ${route}`;
      expect(typeof operation.operationId, label).toBe("string");
      expect(typeof operation.summary, label).toBe("string");
      expect(Array.isArray(operation.tags) && operation.tags.every((tag) => tags.includes(tag)), label).toBe(true);
      expect(Object.keys(at(operation, "responses")).length, label).toBeGreaterThan(0);
    }
  });

  it("resolves every reference", () => {
    const refs = references(spec);
    expect(refs.length).toBeGreaterThan(100);
    for (const ref of new Set(refs)) {
      const [hash, ...segments] = ref.split("/");
      expect(hash, ref).toBe("#");
      expect(() => at(spec, ...segments), ref).not.toThrow();
    }
  });

  it("documents the same-origin rule: every state-changing operation can answer 403, except PayPal's webhook", () => {
    for (const { path: route, method, operation } of operations()) {
      if (method === "get") continue;
      const responses = Object.keys(at(operation, "responses"));
      if (route === "/api/webhooks/paypal") expect(responses).not.toContain("403");
      else expect(responses, `${method} ${route}`).toContain("403");
    }
  });

  it("documents redirects for the browser return routes and JSON everywhere else", () => {
    for (const { path: route, operation } of operations()) {
      const responses = Object.keys(at(operation, "responses"));
      const success = operation.operationId === "createDeal" ? "201" : "200";
      if (route.startsWith("/api/paypal/")) expect(responses, route).toEqual(["303"]);
      else expect(at(operation, "responses", success, "content"), route).toBeDefined();
    }
  });

  it("uses one error shape", () => {
    expect(shape(schemas.ApiErrorBody)).toEqual({ properties: ["error"], required: ["error"] });
    expect(shape(at(schemas, "ApiErrorBody", "properties").error)).toEqual({
      properties: ["code", "details", "message", "requestId"],
      required: ["code", "message", "requestId"],
    });
    expect(at(schemas, "ApiErrorBody", "properties", "error", "properties", "code").enum).toEqual([
      "invalid_request",
      "not_found",
      "forbidden",
      "conflict",
      "rate_limited",
      "payment_error",
      "unavailable",
      "internal",
    ]);
    for (const response of Object.values(at(spec, "components", "responses"))) {
      expect(at(response, "content", "application/json", "schema")).toEqual({ $ref: "#/components/schemas/ApiErrorBody" });
    }
  });

  it("lists the domain's enumerations exactly", () => {
    expect(enumOf("DealStatus")).toEqual([...DEAL_STATUSES]);
    expect(enumOf("PaymentStatus")).toEqual([...PAYMENT_STATUSES]);
    expect(enumOf("Category")).toEqual([...CATEGORIES]);
    expect(enumOf("AspectRatio")).toEqual([...ASPECT_RATIOS]);
    expect(enumOf("Language")).toEqual([...LANGUAGES]);
    expect(enumOf("HumanDecisionKind")).toEqual(HumanDecisionKindSchema.options);
    expect(enumOf("VerificationDecision")).toEqual(VerificationDecisionSchema.options);
    expect(at(schemas, "AuditEvent", "properties", "type").enum).toEqual([...AUDIT_EVENT_TYPES]);
    expect(at(schemas, "AuditEvent", "properties", "actor").enum).toEqual([...AUDIT_ACTORS]);
    expect(at(schemas, "VerificationRule", "properties", "kind").enum).toEqual([...VERIFICATION_RULE_KINDS]);
    expect(at(schemas, "VerificationCheck", "properties", "kind").enum).toEqual([...VERIFICATION_RULE_KINDS]);
    expect(at(schemas, "CreateDealRequest", "properties", "scenarioId").enum).toEqual(SCENARIOS.map((scenario) => scenario.id));
    // Every payment.* audit event has a row type in the operations ledger.
    expect(at(schemas, "OpsPaymentEvent", "properties", "type").enum).toEqual(
      AUDIT_EVENT_TYPES.filter((type) => type.startsWith("payment.")).map((type) => type.slice("payment.".length)),
    );
  });

  it.each([
    ["Mandate", MandateSchema],
    ["Terms", TermsSchema],
    ["IllustrationSpec", IllustrationSpecSchema],
    ["CopySpec", CopySpecSchema],
    ["NegotiationMove", NegotiationMoveSchema],
    ["VerificationRule", VerificationRuleSchema],
    ["SettlementTerms", SettlementTermsSchema],
    ["Contract", ContractSchema],
    ["SignedContract", SignedContractSchema],
    ["Policy", PolicySchema],
    ["PolicyCheck", PolicyCheckSchema],
    ["PolicyEvaluation", PolicyEvaluationSchema],
    ["IllustrationArtifact", IllustrationArtifactSchema],
    ["CopyArtifact", CopyArtifactSchema],
    ["Submission", SubmissionSchema],
    ["VerificationCheck", VerificationCheckSchema],
    ["VerificationReport", VerificationReportSchema],
    ["HumanDecision", HumanDecisionSchema],
    ["AuditEvent", AuditEventSchema],
  ])("%s has exactly the fields of the domain schema, all required", (name, schema) => {
    const fields = Object.keys(schema.shape).sort();
    expect(shape(schemas[name])).toEqual({ properties: fields, required: fields });
  });

  describe("response shapes produced by the code", () => {
    const now = new Date("2026-10-06T05:00:00.000Z");
    const graph: DealGraph = {
      deal: {
        id: "deal_openapi0001",
        code: "PACT-API1",
        owner: "sess_openapi000000000000000000",
        scenarioId: null,
        status: "negotiating",
        intent: "Three landing-page illustrations for under $50.",
        mandate: null,
        category: "illustration",
        sellerId: "northwind",
        negotiationStatus: "open",
        agreedTerms: null,
        negotiationFailure: null,
        policyEvaluation: null,
        humanDecision: null,
        priceMinor: null,
        deadline: null,
        revisionLimit: null,
        revisionsUsed: 0,
        aiDegraded: false,
        lastError: null,
        version: 0,
        lockId: null,
        lockedUntil: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      moves: [],
      signed: null,
      payment: null,
      submissions: [],
      reports: [],
      audit: [],
    };

    const allRequired = (value: object) => {
      const fields = Object.keys(value).sort();
      return { properties: fields, required: fields };
    };

    it("DealView and DealSummary", () => {
      const view = buildDealView(graph, null, now, { providerKind: "simulated" });
      expect(shape(schemas.DealView)).toEqual(allRequired(view));
      const properties = at(schemas, "DealView", "properties");
      expect(shape(properties.negotiation)).toEqual(allRequired(view.negotiation));
      expect(shape(properties.flags)).toEqual(allRequired(view.flags));
      expect(shape(properties.revisions)).toEqual(allRequired(view.revisions));
      expect(shape(schemas.DealSummary)).toEqual(allRequired(toDealSummary(graph.deal)));
      expect(shape(schemas.SellerPublic)).toEqual(allRequired(toSellerPublic(SELLERS[0])));
    });

    it("PaymentRecord", () => {
      const record = newPaymentRecord("simulated", "interactive", 4_700, now);
      expect(shape(schemas.PaymentRecord)).toEqual(allRequired(record));
      expect(shape(at(schemas, "PaymentRecord", "properties").webhookConfirmed)).toEqual(allRequired(record.webhookConfirmed));
      // The one thing a payment record must never grow.
      expect(JSON.stringify(schemas.PaymentRecord).toLowerCase()).not.toContain("vaultid");
    });

    it("SystemStatus, including the optional degraded list", async () => {
      vi.stubEnv("PACT_LOG_SILENT", "1");
      const status = await getSystemStatus({ openDb: databaseDown });
      vi.unstubAllEnvs();
      const documented = shape(schemas.SystemStatus);
      expect(documented.properties).toEqual(Object.keys(status).sort());
      expect(documented.required).toEqual(["ai", "database", "payments", "version"]);
      const properties = at(schemas, "SystemStatus", "properties");
      expect(shape(properties.payments)).toEqual(allRequired(status.payments));
      expect(shape(properties.ai)).toEqual(allRequired(status.ai));
    });

    it("WalletStatus and ReconciliationView", () => {
      const wallet = {
        provider: "simulated",
        supportsVault: true,
        session: { connected: false, pending: false, payerEmailMasked: null },
        demo: { connected: false },
        effectiveMode: "interactive",
      } satisfies WalletStatus;
      expect(shape(schemas.WalletStatus)).toEqual(allRequired(wallet));
      expect(shape(at(schemas, "WalletStatus", "properties").session)).toEqual(allRequired(wallet.session));
      expect(JSON.stringify(schemas.WalletStatus).toLowerCase()).not.toContain("vaultid");

      const reconciliation = {
        dealId: "deal_openapi0001",
        status: "match",
        checkedAt: now.toISOString(),
        facts: [{ field: "Order amount", pact: "$47.00", paypal: "$47.00", match: true }],
        narrative: null,
        toolCalls: [{ tool: "get_order", ok: true }],
        source: "deterministic",
        model: null,
        note: null,
      } satisfies ReconciliationView;
      expect(shape(schemas.ReconciliationView)).toEqual(allRequired(reconciliation));
      expect(shape(schemas.ReconciliationFact)).toEqual(allRequired(reconciliation.facts[0]));
      expect(shape(at(schemas, "ReconciliationView", "properties", "toolCalls").items)).toEqual(allRequired(reconciliation.toolCalls[0]));
    });
  });
});
