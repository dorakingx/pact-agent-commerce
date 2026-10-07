/**
 * Pure view logic for the live deal screen: everything the page shows that is not a field of
 * the deal itself is derived here, so it can be unit-tested without a DOM and so two parts of
 * the screen (the lifecycle rail, the sticky summary, the outcome banner) can never disagree.
 *
 * Nothing in this file reads a clock, the DOM or the network.
 */
import type { DealView, HumanGate } from "@/lib/api/dto";
import { plural, singleLine, truncate } from "@/lib/domain/format";
import { formatMoney } from "@/lib/domain/money";
import type { AgentSource, Contract } from "@/lib/domain/schemas";
import { isTerminal } from "@/lib/domain/status";

/* -------------------------------------------------------------------------- */
/*  Identity                                                                   */
/* -------------------------------------------------------------------------- */

const TITLE_MAX = 110;

/** The page title: the contract's title once there is one, else the buyer agent's restatement, else the request. */
export function dealTitle(deal: Pick<DealView, "contract" | "mandate" | "intent">): string {
  return deal.contract?.contract.title ?? deal.mandate?.summary ?? truncate(singleLine(deal.intent), TITLE_MAX);
}

/** Why a visitor cannot act on a deal. `null` for the owner. */
export type ReadOnlyKind = "showcase" | "other_session";

/**
 * Showcase deals are seeded for everyone to read and carry the buyer's mandate; a deal that
 * belongs to another browser session does not (the mandate holds a private budget ceiling).
 */
export function readOnlyKind(deal: Pick<DealView, "isOwner" | "mandate">): ReadOnlyKind | null {
  if (deal.isOwner) return null;
  return deal.mandate === null ? "other_session" : "showcase";
}

/* -------------------------------------------------------------------------- */
/*  Models                                                                     */
/* -------------------------------------------------------------------------- */

/** Tokens that keep a fixed spelling when a gateway model id is turned into a label. */
const MODEL_TOKEN: Record<string, string> = {
  gpt: "GPT",
  mini: "mini",
  nano: "nano",
  ai: "AI",
};

function modelToken(token: string): string {
  const fixed = MODEL_TOKEN[token];
  if (fixed !== undefined) return fixed;
  return /^[a-z]/.test(token) ? token[0].toUpperCase() + token.slice(1) : token;
}

/**
 * "openai/gpt-5-mini" → "GPT-5 mini", "google/gemini-2.5-flash" → "Gemini 2.5 Flash".
 * A scripted agent never shows a model name, even if one is recorded, so a fallback is never
 * mistaken for a live model.
 */
export function modelLabel(model: string | null, source: AgentSource): string {
  if (source === "scripted") return "Scripted";
  if (model === null || model.trim() === "") return "AI model";
  const name = model.slice(model.lastIndexOf("/") + 1);
  const tokens = name.split("-").filter((token) => token !== "");
  if (tokens.length === 0) return "AI model";
  const [family, ...rest] = tokens.map(modelToken);
  // "GPT-5" is one name; every other family separates its version with a space.
  if (family === "GPT" && rest.length > 0) return [`GPT-${rest[0]}`, ...rest.slice(1)].join(" ");
  return [family, ...rest].join(" ");
}

/** Who turned the human's words into a mandate, read from the audit trail (the view has no field for it). */
export function mandateSource(deal: Pick<DealView, "audit">): { source: AgentSource; model: string | null } | null {
  const event = deal.audit.find((entry) => entry.type === "mandate.derived");
  if (event === undefined) return null;
  const source = event.data?.source === "ai" ? "ai" : "scripted";
  const model = typeof event.data?.model === "string" ? event.data.model : null;
  return { source, model };
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle rail                                                             */
/* -------------------------------------------------------------------------- */

export const LIFECYCLE_STAGE_IDS = [
  "request",
  "negotiation",
  "contract",
  "policy",
  "authorization",
  "delivery",
  "verification",
  "settlement",
] as const;
export type LifecycleStageId = (typeof LIFECYCLE_STAGE_IDS)[number];

export const LIFECYCLE_STAGE_LABEL: Record<LifecycleStageId, string> = {
  request: "Request",
  negotiation: "Negotiation",
  contract: "Contract",
  policy: "Policy",
  authorization: "Authorization",
  delivery: "Delivery",
  verification: "Verification",
  settlement: "Settlement",
};

export type LifecycleState = "done" | "current" | "upcoming" | "failed" | "skipped";
export type LifecycleTone = "success" | "hold" | "info" | "review";

export interface LifecycleStage {
  id: LifecycleStageId;
  label: string;
  state: LifecycleState;
  /** Colour of a done/current node. Amber marks a live authorization hold. */
  tone?: LifecycleTone;
  /** One short fact about the stage ("$28.00 held", "5 / 8 moves"). */
  description?: string;
}

type LifecycleDeal = Pick<
  DealView,
  "status" | "negotiation" | "contract" | "policy" | "payment" | "submissions" | "reports" | "revisions" | "humanDecision"
>;

/** Where the deal is (or stopped), and how that stage should look. */
interface Cursor {
  stage: LifecycleStageId;
  state: "current" | "failed" | "done";
  tone?: LifecycleTone;
  description?: string;
}

function everAuthorized(deal: LifecycleDeal): boolean {
  return deal.payment !== null && deal.payment.authorizationId !== null;
}

function cursorFor(deal: LifecycleDeal): Cursor {
  const { status } = deal;
  switch (status) {
    case "negotiating":
      return {
        stage: "negotiation",
        state: "current",
        tone: "info",
        description: `${deal.negotiation.moves.length} / ${deal.negotiation.maxMoves} moves`,
      };
    case "agreed":
      return { stage: "contract", state: "current", tone: "info", description: "Compiling" };
    case "contracted":
      return { stage: "policy", state: "current", tone: "info", description: "Checking limits" };
    case "awaiting_approval":
      return { stage: "policy", state: "current", tone: "review", description: "Needs your approval" };
    case "payment_pending":
      return { stage: "authorization", state: "current", tone: "info", description: "Creating order" };
    case "awaiting_payment":
      return { stage: "authorization", state: "current", tone: "review", description: "Awaiting payer approval" };
    case "authorized":
      return { stage: "delivery", state: "current", tone: "info", description: "Seller is working" };
    case "revision_required":
      return {
        stage: "delivery",
        state: "current",
        tone: "info",
        description: `Revision ${deal.revisions.used} of ${deal.revisions.limit}`,
      };
    case "submitted":
      return { stage: "verification", state: "current", tone: "info", description: "Checking evidence" };
    case "in_review":
      return { stage: "verification", state: "current", tone: "review", description: "Needs your review" };
    case "verified":
      return { stage: "settlement", state: "current", tone: "success", description: "Capturing" };
    case "rejecting":
      return { stage: "settlement", state: "current", tone: "info", description: "Releasing the hold" };
    case "completed":
      return {
        stage: "settlement",
        state: "done",
        description: deal.payment ? `${formatMoney(deal.payment.capturedMinor)} captured` : "Captured",
      };
    case "rejected":
      return { stage: "verification", state: "failed", description: "Delivery rejected" };
    case "declined":
      return { stage: "policy", state: "failed", description: "Declined by you" };
    case "blocked":
      return { stage: "policy", state: "failed", description: "Blocked" };
    case "negotiation_failed":
      return {
        stage: "negotiation",
        state: "failed",
        description: deal.negotiation.moves.length === 0 ? "No seller" : "No agreement",
      };
    case "cancelled":
      return { stage: "authorization", state: "failed", description: "Cancelled" };
    case "expired":
      return everAuthorized(deal)
        ? { stage: "settlement", state: "failed", description: "Hold expired" }
        : { stage: "authorization", state: "failed", description: "Order expired" };
    case "failed":
      return everAuthorized(deal)
        ? { stage: "settlement", state: "failed", description: "Payment failed" }
        : { stage: "authorization", state: "failed", description: "Payment failed" };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Whether a stage the deal has moved past actually happened (a blocked request never negotiated). */
function stageHappened(id: LifecycleStageId, deal: LifecycleDeal): boolean {
  switch (id) {
    case "request":
      return true;
    case "negotiation":
      return deal.negotiation.status === "agreed";
    case "contract":
      return deal.contract !== null;
    case "policy":
      return deal.policy !== null && deal.policy.outcome !== "block";
    case "authorization":
      return everAuthorized(deal);
    case "delivery":
      return deal.submissions.length > 0;
    case "verification":
      return deal.reports.length > 0;
    case "settlement":
      return deal.status === "completed";
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}

/** The short fact shown under a stage the deal has completed. */
function doneDescription(id: LifecycleStageId, deal: LifecycleDeal): string | undefined {
  switch (id) {
    case "request":
      return undefined;
    case "negotiation": {
      const price = deal.negotiation.agreedTerms?.priceMinor;
      return price === undefined ? undefined : `Agreed ${formatMoney(price)}`;
    }
    case "contract":
      return deal.contract ? `sha256 ${deal.contract.termsHash.slice(0, 8)}` : undefined;
    case "policy":
      if (deal.policy === null) return undefined;
      return deal.policy.outcome === "needs_approval" ? "Approved by you" : "Within policy";
    case "authorization": {
      if (deal.payment === null) return undefined;
      const amount = formatMoney(deal.payment.authorizedMinor);
      return deal.payment.status === "authorized" ? `${amount} held` : `${amount} authorized`;
    }
    case "delivery": {
      const latest = deal.submissions[deal.submissions.length - 1];
      return latest ? plural(latest.artifacts.length, "file") : undefined;
    }
    case "verification": {
      const latest = deal.reports[deal.reports.length - 1];
      if (latest === undefined) return undefined;
      if (deal.humanDecision?.kind === "release_payment" || deal.humanDecision?.kind === "release_partial") {
        return "Released by you";
      }
      const passed = latest.checks.filter((check) => check.result === "pass").length;
      return `${passed} of ${latest.checks.length} passed`;
    }
    case "settlement":
      return undefined;
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}

/**
 * The eight stages of the lifecycle rail.
 *
 *  - Stages before the cursor are `done` when they really happened, `skipped` otherwise.
 *  - A live authorization hold is amber: the money is reserved, not moved.
 *  - A terminal failure marks the stage where the deal stopped; what follows is `skipped`.
 *    The one exception is a rejected delivery, whose settlement did happen: the hold was voided.
 */
export function lifecycleStages(deal: LifecycleDeal): LifecycleStage[] {
  const cursor = cursorFor(deal);
  const cursorIndex = LIFECYCLE_STAGE_IDS.indexOf(cursor.stage);
  const ended = isTerminal(deal.status);
  const holding = deal.payment?.status === "authorized";

  return LIFECYCLE_STAGE_IDS.map((id, index): LifecycleStage => {
    const label = LIFECYCLE_STAGE_LABEL[id];
    if (index === cursorIndex) {
      return { id, label, state: cursor.state, tone: cursor.tone, description: cursor.description };
    }
    if (index < cursorIndex) {
      if (!stageHappened(id, deal)) return { id, label, state: "skipped" };
      const tone: LifecycleTone | undefined = id === "authorization" && holding ? "hold" : undefined;
      return { id, label, state: "done", tone, description: doneDescription(id, deal) };
    }
    if (!ended) return { id, label, state: "upcoming" };
    if (id === "settlement" && deal.status === "rejected") {
      return { id, label, state: "skipped", description: "Voided · nothing captured" };
    }
    return { id, label, state: "skipped" };
  });
}

/** "5 of 8 · Authorization" for the compact (mobile) rail. */
export function lifecyclePosition(stages: readonly LifecycleStage[]): { index: number; stage: LifecycleStage } {
  const at = stages.findIndex((stage) => stage.state === "current" || stage.state === "failed");
  if (at !== -1) return { index: at, stage: stages[at] };
  // Completed: the last stage that happened.
  let last = 0;
  stages.forEach((stage, index) => {
    if (stage.state === "done") last = index;
  });
  return { index: last, stage: stages[last] };
}

/* -------------------------------------------------------------------------- */
/*  Funds: held, captured, released                                            */
/* -------------------------------------------------------------------------- */

/**
 *  none      no order yet
 *  pending   an order exists; nothing is held
 *  held      authorized: the money is reserved on the payer's account, not moved
 *  captured  the money moved to the seller (the rest, if any, was released)
 *  released  the hold was voided or expired: nothing moved
 *  closed    the order ended before anything was held
 *  failed    the provider failed terminally
 */
export type FundsPhase = "none" | "pending" | "held" | "captured" | "released" | "closed" | "failed";

export interface FundsView {
  phase: FundsPhase;
  /** Contract price, or 0 before there is a contract. */
  priceMinor: number;
  /** Reserved right now and not yet captured or released. */
  heldMinor: number;
  capturedMinor: number;
  /** Given back to the payer: a voided or expired hold, or the remainder of a partial capture. */
  releasedMinor: number;
}

export function fundsView(deal: Pick<DealView, "payment" | "contract">): FundsView {
  const priceMinor = deal.contract?.contract.price.amountMinor ?? deal.payment?.amountMinor ?? 0;
  const payment = deal.payment;
  const empty = { priceMinor, heldMinor: 0, capturedMinor: 0, releasedMinor: 0 };
  if (payment === null) return { phase: "none", ...empty };
  switch (payment.status) {
    case "none":
      return { phase: "none", ...empty };
    case "created":
    case "approved":
      return { phase: "pending", ...empty };
    case "authorized":
      return { phase: "held", ...empty, heldMinor: Math.max(0, payment.authorizedMinor - payment.capturedMinor) };
    case "captured":
      return {
        phase: "captured",
        ...empty,
        capturedMinor: payment.capturedMinor,
        releasedMinor: Math.max(0, payment.authorizedMinor - payment.capturedMinor),
      };
    case "voided":
    case "expired":
      return payment.authorizationId === null
        ? { phase: "closed", ...empty }
        : { phase: "released", ...empty, releasedMinor: payment.authorizedMinor };
    case "failed":
      return { phase: "failed", ...empty, capturedMinor: payment.capturedMinor };
    default: {
      const exhaustive: never = payment.status;
      return exhaustive;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Gates, polling, activity                                                   */
/* -------------------------------------------------------------------------- */

/** The human gate that is open for this viewer, if any. Visitors never see a gate. */
export function openGate(deal: Pick<DealView, "isOwner" | "next">): HumanGate | null {
  return deal.isOwner && deal.next.kind === "human" ? deal.next.gate : null;
}

export const GATE_POLL_MS = 4_000;

/**
 * How often to re-read a deal the page is not driving itself: while a human gate is open (a
 * webhook or another tab may move it) and while a visitor watches somebody else's deal run.
 * 0 switches polling off.
 */
export function pollIntervalMs(deal: Pick<DealView, "isOwner" | "next"> | undefined): number {
  if (deal === undefined) return 0;
  if (deal.next.kind === "done") return 0;
  if (deal.next.kind === "human") return GATE_POLL_MS;
  return deal.isOwner ? 0 : GATE_POLL_MS;
}

/** What the runner is doing, as far as the activity line needs to know. */
export type RunnerActivity = "idle" | "running" | "busy" | "retrying" | "stalled" | "failed";

export interface ActivityLine {
  text: string;
  /** `working` shows a spinner, `waiting` a violet dot, `paused` and `problem` a static icon. */
  kind: "working" | "waiting" | "paused" | "problem" | "done";
}

export function activityLine(
  deal: Pick<DealView, "isOwner" | "next">,
  runner: { phase: RunnerActivity; autoRun: boolean },
): ActivityLine {
  const { next } = deal;
  if (next.kind === "done") return { text: next.label, kind: "done" };
  if (next.kind === "human") {
    return deal.isOwner
      ? { text: next.label, kind: "waiting" }
      : { text: "Waiting for a decision from the deal's owner", kind: "waiting" };
  }
  if (!deal.isOwner) return { text: `${next.label} — running in the owner's session`, kind: "working" };
  switch (runner.phase) {
    case "stalled":
      return { text: "Paused — the last step did not complete", kind: "problem" };
    case "failed":
      return { text: "Paused — the last request failed", kind: "problem" };
    case "retrying":
      return { text: `${next.label} — connection problem, retrying…`, kind: "working" };
    case "busy":
      return { text: `${next.label} — still working…`, kind: "working" };
    case "running":
      return { text: `${next.label}…`, kind: "working" };
    case "idle":
      return runner.autoRun
        ? { text: `${next.label}…`, kind: "working" }
        : { text: `Auto-run is off — next: ${lowerFirst(next.label)}`, kind: "paused" };
    default: {
      const exhaustive: never = runner.phase;
      return exhaustive;
    }
  }
}

function lowerFirst(text: string): string {
  // Proper nouns ("PayPal") and acronyms keep their capital.
  return /^[A-Z][a-z]+ /.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/* -------------------------------------------------------------------------- */
/*  Version ordering                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Whether `incoming` may replace `current` on screen. The audit trail is append-only and
 * gapless, so its length is a version counter; `updatedAt` breaks ties. A slow poll that
 * resolves after an advance must never roll the page back.
 */
export function supersedes(
  current: Pick<DealView, "audit" | "updatedAt"> | undefined,
  incoming: Pick<DealView, "audit" | "updatedAt">,
): boolean {
  if (current === undefined) return true;
  if (incoming.audit.length !== current.audit.length) return incoming.audit.length > current.audit.length;
  return incoming.updatedAt >= current.updatedAt;
}

/* -------------------------------------------------------------------------- */
/*  Outcome                                                                    */
/* -------------------------------------------------------------------------- */

export interface DealOutcome {
  tone: "success" | "neutral" | "danger";
  title: string;
  detail: string;
  /** PayPal capture id, shown next to a captured outcome. */
  captureId: string | null;
}

type OutcomeDeal = Pick<
  DealView,
  "status" | "payment" | "contract" | "negotiation" | "policy" | "humanDecision" | "lastError" | "reports" | "seller"
>;

function blockedReason(deal: OutcomeDeal): string {
  const blocking = deal.policy?.checks.filter((check) => check.outcome === "block").map((check) => check.detail) ?? [];
  if (blocking.length > 0) return blocking.join(" ");
  return deal.lastError ?? "The spending policy does not allow this purchase.";
}

/** The final banner. `null` while the deal is still running or waiting. */
export function dealOutcome(deal: OutcomeDeal): DealOutcome | null {
  const payment = deal.payment;
  const price = deal.contract?.contract.price.amountMinor ?? payment?.amountMinor ?? 0;
  const sellerName = deal.seller?.name ?? "the seller";
  switch (deal.status) {
    case "completed": {
      const captured = payment?.capturedMinor ?? price;
      const partial = captured < price;
      const conditions = deal.contract?.contract.verificationRules.length ?? 0;
      const byHuman = deal.humanDecision?.kind === "release_payment" || deal.humanDecision?.kind === "release_partial";
      return {
        tone: "success",
        title: partial ? `Captured ${formatMoney(captured)} of ${formatMoney(price)}` : `Captured ${formatMoney(captured)}`,
        detail: partial
          ? `You released part of the payment to ${sellerName}. The remaining ${formatMoney(price - captured)} was released back to the payer.`
          : byHuman
            ? `You released the payment to ${sellerName} after reviewing the delivery.`
            : `The delivery passed all ${plural(conditions, "contract condition")}, so PACT captured the authorized payment for ${sellerName}.`,
        captureId: payment?.captureId ?? null,
      };
    }
    case "rejected":
      return {
        tone: "neutral",
        title: "Authorization voided — nothing was captured",
        detail:
          deal.humanDecision?.kind === "reject_delivery"
            ? `You rejected the delivery. The ${formatMoney(price)} hold was released back to the payer.`
            : `The delivery did not satisfy the contract and no revisions remained. The ${formatMoney(price)} hold was released back to the payer.`,
        captureId: null,
      };
    case "declined":
      return {
        tone: "neutral",
        title: "Spend declined — no payment was created",
        detail: "You declined the spend at the approval gate, so the deal ended before any PayPal order existed.",
        captureId: null,
      };
    case "blocked":
      return {
        tone: "danger",
        title: "Blocked by policy — no payment was created",
        detail: blockedReason(deal),
        captureId: null,
      };
    case "negotiation_failed":
      return {
        tone: "neutral",
        title: "No agreement — nothing was authorized",
        detail: deal.negotiation.failureReason ?? "The agents could not agree on terms.",
        captureId: null,
      };
    case "cancelled":
      return {
        tone: "neutral",
        title: "Deal cancelled — nothing was captured",
        detail:
          payment !== null && payment.authorizationId !== null
            ? `The ${formatMoney(payment.authorizedMinor)} hold was released back to the payer.`
            : "The PayPal approval was cancelled before any funds were held.",
        captureId: null,
      };
    case "expired":
      return {
        tone: "neutral",
        title: "Authorization expired — nothing was captured",
        detail:
          deal.lastError ??
          "The hold lapsed before the deal could be settled, so the funds went back to the payer.",
        captureId: null,
      };
    case "failed":
      return {
        tone: "danger",
        title: "Payment failed",
        detail: deal.lastError ?? payment?.lastError?.message ?? "The payment provider reported a failure that cannot be retried.",
        captureId: null,
      };
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Contract                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The contract's settlement terms as one paragraph a non-technical reader can check against
 * what happens next: "Captured only when all 6 conditions are verified. Below 85% confidence a
 * human decides. If revisions run out, the authorization is voided."
 */
export function settlementSentence(contract: Pick<Contract, "verificationRules" | "settlement" | "revisionLimit">): string {
  const required = contract.verificationRules.filter((rule) => rule.required).length;
  const threshold = Math.round(contract.settlement.autoCaptureMinConfidence * 100);
  const capture =
    required === 1
      ? "Captured only when the one condition is verified."
      : `Captured only when all ${required} conditions are verified.`;
  const review = `Below ${threshold}% confidence a human decides.`;
  const exhausted =
    contract.revisionLimit === 0
      ? "There are no revision rounds: a failed delivery voids the authorization."
      : "If revisions run out, the authorization is voided.";
  return `${capture} ${review} ${exhausted}`;
}

/**
 * The same value with every object's keys in canonical (sorted) order, arrays untouched: the
 * order in which the contract is serialised before it is hashed. Showing the JSON this way
 * means the text on screen is, whitespace aside, the text the terms hash was computed over.
 */
export function canonicalOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalOrder);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = canonicalOrder(source[key]);
  return sorted;
}

/* -------------------------------------------------------------------------- */
/*  PayPal return                                                              */
/* -------------------------------------------------------------------------- */

export const PAYPAL_RETURN_RESULTS = ["approved", "pending", "cancelled", "error"] as const;
export type PayPalReturn = (typeof PAYPAL_RETURN_RESULTS)[number];

export function parsePayPalReturn(value: string | string[] | undefined | null): PayPalReturn | null {
  const first = Array.isArray(value) ? value[0] : value;
  return (PAYPAL_RETURN_RESULTS as readonly string[]).includes(first ?? "") ? (first as PayPalReturn) : null;
}

export interface ReturnToast {
  kind: "success" | "info" | "warning" | "error";
  title: string;
  description: string;
}

/** The toast shown when the payer comes back from the approval page with `?paypal=…`. */
export function payPalReturnToast(result: PayPalReturn): ReturnToast {
  switch (result) {
    case "approved":
      return {
        kind: "success",
        title: "Approval received — funds are held",
        description: "The amount is authorized, not captured. It moves only after the delivery is verified.",
      };
    case "pending":
      return {
        kind: "info",
        title: "Approval received — authorization pending",
        description: "PayPal has not confirmed the hold yet. This page updates as soon as it does.",
      };
    case "cancelled":
      return {
        kind: "warning",
        title: "Approval cancelled",
        description: "Nothing was authorized and nothing was charged.",
      };
    case "error":
      return {
        kind: "error",
        title: "The approval could not be completed",
        description: "Nothing was captured. Check the payment section for details and try again.",
      };
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

/**
 * The approval link the browser may navigate to: PACT's own simulated approval page (a
 * same-origin path) or PayPal over https. Anything else is refused, so a corrupted record can
 * never turn the primary button into an open redirect.
 */
export function safeApproveUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url === "") return null;
  if (url.startsWith("/")) return url.startsWith("//") || url.includes("\\") ? null : url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  return host === "paypal.com" || host.endsWith(".paypal.com") ? parsed.toString() : null;
}

/* -------------------------------------------------------------------------- */
/*  Time                                                                       */
/* -------------------------------------------------------------------------- */

export interface LocalTimeOptions {
  locale?: string;
  timeZone?: string;
  /** Lead with the weekday (default). Chips that must stay short switch it off. */
  weekday?: boolean;
}

/**
 * "Wed, Oct 7, 6:00 PM" in the viewer's own time zone: a deadline the human typed as
 * "tomorrow at 6 PM" should read back the way they said it. Client-only (depends on the zone).
 */
export function formatLocalDateTime(iso: string, options: LocalTimeOptions = {}): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "Unknown time";
  return new Intl.DateTimeFormat(options.locale ?? "en-US", {
    weekday: options.weekday === false ? undefined : "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: options.timeZone,
  }).format(new Date(ms));
}

/** "6:04:12 PM" for audit entries, where seconds separate steps that follow each other closely. */
export function formatLocalClock(iso: string, options: LocalTimeOptions = {}): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Intl.DateTimeFormat(options.locale ?? "en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: options.timeZone,
  }).format(new Date(ms));
}

/** "2.1 s" / "840 ms" for agent latency. */
export function formatLatency(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** "42 s" / "1 min 12 s" / "2 h 05 min": how long the deal took, where seconds matter. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min ${(totalSeconds % 60).toString().padStart(2, "0")} s`;
  return `${Math.floor(totalMinutes / 60)} h ${(totalMinutes % 60).toString().padStart(2, "0")} min`;
}

/** From the request to the last recorded event. */
export function dealElapsedMs(deal: Pick<DealView, "createdAt" | "audit">): number {
  const last = deal.audit[deal.audit.length - 1];
  return last === undefined ? 0 : Math.max(0, Date.parse(last.at) - Date.parse(deal.createdAt));
}
