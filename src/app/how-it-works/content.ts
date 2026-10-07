/**
 * What the "How it works" page claims about the system, as data.
 *
 * Kept apart from the markup so that `content.test.ts` can hold each claim against the code it
 * describes: the PayPal paths against the PayPal client, the spending checks against the
 * policy engine, the decisions against the verification schema.
 */
import { formatMoney } from "@/lib/domain/money";
import { evaluatePolicy } from "@/lib/domain/policy";
import { DEFAULT_POLICY, type PolicyCheck, type VerificationDecision } from "@/lib/domain/schemas";

/* -------------------------------------------------------------------------- */
/*  Who does what                                                              */
/* -------------------------------------------------------------------------- */

export interface RoleItem {
  name: string;
  detail: string;
}

export interface Role {
  id: "models" | "code" | "paypal";
  kicker: string;
  title: string;
  summary: string;
  items: readonly RoleItem[];
  /** The limit of this role: what it can never do, or the guarantee it gives. */
  boundary: string;
}

export const ROLES: readonly Role[] = [
  {
    id: "models",
    kicker: "Models propose",
    title: "Agents do the talking and the work",
    summary: "Useful, and never trusted on their own word.",
    items: [
      { name: "Buyer agent", detail: "Turns your request into a mandate and negotiates inside your budget." },
      { name: "Seller agent", detail: "Quotes from its own rate card, negotiates, and produces the deliverable." },
      { name: "AI verifier", detail: "Judges the subjective conditions, with evidence and a confidence score." },
      { name: "Auditor agent", detail: "Re-reads PayPal’s record of the order through one read-only tool." },
    ],
    boundary: "Every output is parsed against a strict schema. No model holds a tool that can authorize, capture or void.",
  },
  {
    id: "code",
    kicker: "Deterministic code decides",
    title: "Engines turn proposals into decisions",
    summary: "Pure functions. Same input, same answer.",
    items: [
      { name: "Negotiation rules", detail: "Turn order and move limit. The buyer can never agree above its budget." },
      { name: "Contract engine", detail: "Compiles the agreed terms and hashes them: SHA-256 over canonical JSON." },
      { name: "Policy engine", detail: "Five spending checks decide: allow, ask a human, or block." },
      { name: "Verification decision", detail: "Deterministic checks plus the AI’s findings become a computed decision." },
      { name: "Capture guard", detail: "The last check before money moves: status, contract hash, report, amount, expiry." },
    ],
    boundary: "Each decision is appended to a hash-chained audit log, so it can be replayed and cannot be quietly edited.",
  },
  {
    id: "paypal",
    kicker: "PayPal moves the money",
    title: "Funds are held first, captured on proof",
    summary: "Authorization and capture, in the PayPal Sandbox.",
    items: [
      { name: "Authorize", detail: "The contract price is held on the payer’s account before any work starts." },
      { name: "Capture", detail: "Only after the capture guard passes, for the amount in the contract." },
      { name: "Void", detail: "If the contract is not met, the hold is released and nothing is captured." },
      { name: "Webhooks", detail: "Signed events confirm what happened. They never trigger a capture." },
    ],
    boundary: "PACT never takes custody of funds. Only its payment orchestrator calls the endpoints that move money.",
  },
];

export interface HumanGate {
  name: string;
  when: string;
}

/** The three points where the engine stops and waits for a person. */
export const HUMAN_GATES: readonly HumanGate[] = [
  { name: "Approve the spend", when: "The price is above the autonomous limit, or the seller is new." },
  { name: "Approve in PayPal", when: "No delegated wallet is connected, so the payer consents to the hold." },
  { name: "Review the delivery", when: "Verification is ambiguous, or the delivery looks like an attempt to manipulate it." },
];

/* -------------------------------------------------------------------------- */
/*  PayPal calls                                                               */
/* -------------------------------------------------------------------------- */

export interface PayPalCall {
  id: string;
  api: "Orders v2" | "Payments v2" | "Vault v3" | "Webhooks";
  purpose: string;
  method: "POST" | "GET";
  /** Path template exactly as the PayPal client declares it. */
  path: string;
  detail: string;
  /**
   * One of the four calls that move or hold money. Each carries a deterministic
   * `PayPal-Request-Id` and is recorded in the idempotency ledger.
   */
  movesMoney: boolean;
}

export const PAYPAL_CALLS: readonly PayPalCall[] = [
  {
    id: "create-order",
    api: "Orders v2",
    purpose: "Open the order",
    method: "POST",
    path: "/v2/checkout/orders",
    detail: "intent AUTHORIZE, amount = contract price, custom_id = pact:v1:<terms hash>, invoice_id = contract id.",
    movesMoney: true,
  },
  {
    id: "authorize-order",
    api: "Orders v2",
    purpose: "Hold the funds",
    method: "POST",
    path: "/v2/checkout/orders/{id}/authorize",
    detail: "After re-reading the order: its amount and custom_id must still match the contract.",
    movesMoney: true,
  },
  {
    id: "capture",
    api: "Payments v2",
    purpose: "Pay on proof",
    method: "POST",
    path: "/v2/payments/authorizations/{id}/capture",
    detail: "final_capture, and only after the capture guard and a fresh read of the authorization.",
    movesMoney: true,
  },
  {
    id: "void",
    api: "Payments v2",
    purpose: "Release otherwise",
    method: "POST",
    path: "/v2/payments/authorizations/{id}/void",
    detail: "When the delivery is rejected, by verification or by a human reviewer. Nothing is captured.",
    movesMoney: true,
  },
  {
    id: "vault-setup",
    api: "Vault v3",
    purpose: "Delegated wallet: consent",
    method: "POST",
    path: "/v3/vault/setup-tokens",
    detail: "Starts the one-time consent. The payer approves it in PayPal.",
    movesMoney: false,
  },
  {
    id: "vault-token",
    api: "Vault v3",
    purpose: "Delegated wallet: token",
    method: "POST",
    path: "/v3/vault/payment-tokens",
    detail: "Exchanges the consent for a payment token. Later in-policy orders authorize without a login.",
    movesMoney: false,
  },
  {
    id: "verify-webhook",
    api: "Webhooks",
    purpose: "Trust an event",
    method: "POST",
    path: "/v1/notifications/verify-webhook-signature",
    detail: "An incoming event is acted on only after PayPal confirms its signature. Events are deduplicated by id.",
    movesMoney: false,
  },
];

/** How a retry is kept from moving money twice. */
export const IDEMPOTENCY_NOTE =
  "Each call that holds or moves money carries a deterministic PayPal-Request-Id and is written to a ledger first. If the process dies after PayPal accepted a capture, the retry replays the same key and adopts that capture instead of making a second one.";

/* -------------------------------------------------------------------------- */
/*  Verification decisions                                                     */
/* -------------------------------------------------------------------------- */

export interface DecisionRow {
  decision: VerificationDecision;
  situation: string;
  money: string;
}

export const VERIFICATION_ROWS: readonly DecisionRow[] = [
  {
    decision: "capture_eligible",
    situation: "Every required condition passes at or above the auto-capture confidence.",
    money: "Captured",
  },
  {
    decision: "revision_required",
    situation: "A required condition clearly fails and a revision remains.",
    money: "Held, not captured",
  },
  {
    decision: "reject",
    situation: "A required condition clearly fails and no revision remains.",
    money: "Hold voided",
  },
  {
    decision: "human_review",
    situation: "Anything ambiguous: low confidence, the AI verifier unavailable, or suspected manipulation.",
    money: "Held until a human decides",
  },
];

/* -------------------------------------------------------------------------- */
/*  Spending controls                                                          */
/* -------------------------------------------------------------------------- */

export interface SpendingControl {
  id: string;
  /** The check's name, as the policy engine reports it. */
  label: string;
  rule: string;
  /** What a check that does not pass does to the deal. */
  effect: Exclude<PolicyCheck["outcome"], "pass">;
}

const CONTROL_COPY: Record<string, Pick<SpendingControl, "rule" | "effect">> = {
  category_allowed: { rule: "The work must be in a category you allow. Restricted work is refused whatever the policy says.", effect: "block" },
  per_transaction_max: {
    rule: `One deal may not exceed the per-transaction maximum (${formatMoney(DEFAULT_POLICY.maxTransactionMinor)} by default).`,
    effect: "block",
  },
  daily_limit: {
    rule: `Everything authorized in a UTC day may not exceed the daily limit (${formatMoney(DEFAULT_POLICY.dailyLimitMinor)} by default).`,
    effect: "block",
  },
  autonomous_limit: {
    rule: `Above the autonomous limit (${formatMoney(DEFAULT_POLICY.autonomousLimitMinor)} by default) the agent may not commit funds alone.`,
    effect: "needs_approval",
  },
  seller_trust: { rule: "A seller with no settled history waits for a person, unless you switch that rule off.", effect: "needs_approval" },
};

/**
 * The five checks, read from the engine itself: their ids, names and order come from a real
 * evaluation, so this page cannot list a check the engine does not run, or miss one it does.
 */
export function spendingControls(): SpendingControl[] {
  const { checks } = evaluatePolicy(DEFAULT_POLICY, {
    amountMinor: 0,
    category: "illustration",
    seller: { id: "example", name: "Example seller", trust: "established" },
    spentTodayMinor: 0,
    now: new Date(0),
  });
  return checks.map((check) => {
    const copy = CONTROL_COPY[check.id];
    if (copy === undefined) throw new Error(`The policy engine reports a check this page does not describe: ${check.id}`);
    return { id: check.id, label: check.label, ...copy };
  });
}

/* -------------------------------------------------------------------------- */
/*  Further reading                                                            */
/* -------------------------------------------------------------------------- */

export const DOCS_BASE_URL = "https://github.com/dorakingx/pact-agent-commerce/blob/main/docs";

export interface Resource {
  id: string;
  title: string;
  description: string;
  href: string;
  external: boolean;
}

export const RESOURCES: readonly Resource[] = [
  {
    id: "architecture",
    title: "Architecture",
    description: "Components, the deal state machine, how a step executes, degraded modes.",
    href: `${DOCS_BASE_URL}/architecture.md`,
    external: true,
  },
  {
    id: "security",
    title: "Security model",
    description: "Trust boundaries, what a model can and cannot reach, how deliveries are sanitised.",
    href: `${DOCS_BASE_URL}/security.md`,
    external: true,
  },
  {
    id: "openapi",
    title: "OpenAPI description",
    description: "Every HTTP endpoint of this deployment, machine-readable.",
    href: "/openapi.json",
    external: false,
  },
];
