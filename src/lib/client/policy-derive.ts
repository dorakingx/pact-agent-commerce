/**
 * Pure view logic of the Policies page: the form draft, its validation, and everything the
 * page derives from it (the live "what would happen" preview, the limit bands, the daily
 * spend meter, the wallet summary).
 *
 * Nothing here touches React or the DOM, so it is unit-tested in Node. The preview calls the
 * same `evaluatePolicy` the server runs before any PayPal call — the browser never re-implements
 * a limit, it only feeds the engine the values currently in the form.
 */
import type { WalletStatus } from "../api/dto";
import { ApiClientError } from "./api";
import { MAX_AMOUNT_MINOR, formatMoney } from "../domain/money";
import { evaluatePolicy } from "../domain/policy";
import { CATEGORIES, PolicySchema, type Category, type Policy, type PolicyEvaluation } from "../domain/schemas";
import type { SellerProfile } from "../domain/sellers";

/* -------------------------------------------------------------------------- */
/*  Money text                                                                 */
/* -------------------------------------------------------------------------- */

export type MoneyParse = { ok: true; minor: number } | { ok: false; message: string };

/** "100", "100.5", "100.50", "1,000.00", with an optional leading "$". A trailing "." is tolerated ("12."). */
const DOLLARS_PATTERN = /^\$?\s*((?:\d{1,3}(?:,\d{3})+|\d{1,9}))(?:\.(\d{0,2}))?$/;

/**
 * Parse what a person types into a dollar field into integer minor units. The conversion is
 * done on the digits, never through a float, so "0.29" is 29 cents and not 28.999….
 */
export function parseDollars(text: string): MoneyParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: "Enter an amount." };
  const match = DOLLARS_PATTERN.exec(trimmed);
  if (match === null) return { ok: false, message: "Enter a dollar amount such as 100 or 100.50." };
  const whole = Number((match[1] ?? "").replaceAll(",", ""));
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const minor = whole * 100 + cents;
  if (minor > MAX_AMOUNT_MINOR) {
    return { ok: false, message: `Cannot exceed ${formatMoney(MAX_AMOUNT_MINOR)}, the ceiling of this sandbox.` };
  }
  return { ok: true, minor };
}

/** Minor units as field text: "1,000.00" (the "$" is an adornment of the field, not part of its value). */
export function formatDollarsInput(minor: number): string {
  return formatMoney(minor).slice(1);
}

/* -------------------------------------------------------------------------- */
/*  Draft                                                                      */
/* -------------------------------------------------------------------------- */

export const MONEY_FIELDS = ["autonomousLimitMinor", "maxTransactionMinor", "dailyLimitMinor"] as const;
export type MoneyField = (typeof MONEY_FIELDS)[number];

/** Categories a person can switch on or off. "restricted" is refused by the engine whatever the policy says. */
export const EDITABLE_CATEGORIES = CATEGORIES.filter((category) => category !== "restricted");

export const AUTO_CAPTURE_MIN_PERCENT = 50;

/**
 * The form's state. Amounts stay as text while they are edited (a half-typed "12." must not be
 * rewritten under the cursor); confidences are whole percentages, which is what the sliders move in.
 */
export interface PolicyDraft {
  money: Record<MoneyField, string>;
  allowedCategories: readonly Category[];
  requireApprovalForNewSellers: boolean;
  autoCapturePercent: number;
  humanReviewPercent: number;
}

function canonicalCategories(categories: readonly Category[]): Category[] {
  return EDITABLE_CATEGORIES.filter((category) => categories.includes(category));
}

function clampPercent(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

export function draftFromPolicy(policy: Policy): PolicyDraft {
  return {
    money: {
      autonomousLimitMinor: formatDollarsInput(policy.autonomousLimitMinor),
      maxTransactionMinor: formatDollarsInput(policy.maxTransactionMinor),
      dailyLimitMinor: formatDollarsInput(policy.dailyLimitMinor),
    },
    allowedCategories: canonicalCategories(policy.allowedCategories),
    requireApprovalForNewSellers: policy.requireApprovalForNewSellers,
    autoCapturePercent: clampPercent(policy.autoCaptureMinConfidence * 100, AUTO_CAPTURE_MIN_PERCENT, 100),
    humanReviewPercent: clampPercent(policy.humanReviewMinConfidence * 100, 0, 100),
  };
}

export type DraftAction =
  | { type: "money"; field: MoneyField; text: string }
  /** Leaving a field tidies a valid amount to "1,000.00"; an invalid one is left for the person to fix. */
  | { type: "money_blur"; field: MoneyField }
  | { type: "category"; category: Category; allowed: boolean }
  | { type: "new_seller_approval"; required: boolean }
  | { type: "auto_capture"; percent: number }
  | { type: "human_review"; percent: number }
  | { type: "replace"; policy: Policy };

export function reduceDraft(draft: PolicyDraft, action: DraftAction): PolicyDraft {
  switch (action.type) {
    case "money":
      return { ...draft, money: { ...draft.money, [action.field]: action.text } };
    case "money_blur": {
      const parsed = parseDollars(draft.money[action.field]);
      if (!parsed.ok) return draft;
      return { ...draft, money: { ...draft.money, [action.field]: formatDollarsInput(parsed.minor) } };
    }
    case "category": {
      if (action.category === "restricted") return draft;
      const others = draft.allowedCategories.filter((category) => category !== action.category);
      return { ...draft, allowedCategories: canonicalCategories(action.allowed ? [...others, action.category] : others) };
    }
    case "new_seller_approval":
      return { ...draft, requireApprovalForNewSellers: action.required };
    case "auto_capture": {
      const autoCapturePercent = clampPercent(action.percent, AUTO_CAPTURE_MIN_PERCENT, 100);
      // The review floor can never sit above the capture threshold, so it follows it down.
      return { ...draft, autoCapturePercent, humanReviewPercent: Math.min(draft.humanReviewPercent, autoCapturePercent) };
    }
    case "human_review":
      return { ...draft, humanReviewPercent: clampPercent(action.percent, 0, draft.autoCapturePercent) };
    case "replace":
      return draftFromPolicy(action.policy);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type PolicyField = keyof Policy;
export type FieldErrors = Partial<Record<PolicyField, string>>;

const POLICY_FIELDS: readonly PolicyField[] = [
  "autonomousLimitMinor",
  "maxTransactionMinor",
  "dailyLimitMinor",
  "allowedCategories",
  "requireApprovalForNewSellers",
  "autoCaptureMinConfidence",
  "humanReviewMinConfidence",
];

function isPolicyField(value: unknown): value is PolicyField {
  return typeof value === "string" && (POLICY_FIELDS as readonly string[]).includes(value);
}

/** Schema messages are written as fragments ("autonomous limit cannot exceed …"); fields show sentences. */
function asSentence(message: string): string {
  const trimmed = message.trim();
  if (trimmed === "") return "This value is not valid.";
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

export interface DraftValidation {
  /** The draft as a policy when every amount could be read, whether or not it satisfies the schema. */
  candidate: Policy | null;
  /** The policy to save: present only when the draft is valid. */
  policy: Policy | null;
  errors: FieldErrors;
}

/**
 * Validate the draft with the same schema the server applies (`PolicySchema`), so a value the
 * form accepts is a value the API accepts.
 */
export function validateDraft(draft: PolicyDraft): DraftValidation {
  const errors: FieldErrors = {};
  const amounts: Partial<Record<MoneyField, number>> = {};
  for (const field of MONEY_FIELDS) {
    const parsed = parseDollars(draft.money[field]);
    if (parsed.ok) amounts[field] = parsed.minor;
    else errors[field] = parsed.message;
  }
  const { autonomousLimitMinor, maxTransactionMinor, dailyLimitMinor } = amounts;
  if (autonomousLimitMinor === undefined || maxTransactionMinor === undefined || dailyLimitMinor === undefined) {
    return { candidate: null, policy: null, errors };
  }

  const candidate: Policy = {
    autonomousLimitMinor,
    maxTransactionMinor,
    dailyLimitMinor,
    allowedCategories: canonicalCategories(draft.allowedCategories),
    requireApprovalForNewSellers: draft.requireApprovalForNewSellers,
    autoCaptureMinConfidence: draft.autoCapturePercent / 100,
    humanReviewMinConfidence: draft.humanReviewPercent / 100,
  };
  const result = PolicySchema.safeParse(candidate);
  if (result.success) return { candidate, policy: candidate, errors };

  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (isPolicyField(field) && errors[field] === undefined) errors[field] = asSentence(issue.message);
  }
  return { candidate, policy: null, errors };
}

/**
 * Field errors from a 400 of PUT /api/policy (`details.issues[].path` names the field). The
 * payload is untrusted input like any other: anything that is not that shape yields no errors.
 */
export function serverFieldErrors(details: unknown): FieldErrors {
  if (typeof details !== "object" || details === null) return {};
  const issues: unknown = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return {};
  const errors: FieldErrors = {};
  for (const issue of issues as unknown[]) {
    if (typeof issue !== "object" || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof path !== "string" || typeof message !== "string") continue;
    const field = path.split(".")[0];
    if (isPolicyField(field) && errors[field] === undefined) errors[field] = asSentence(message);
  }
  return errors;
}

/** Same policy, regardless of the order the categories happen to be listed in. */
export function policiesEqual(a: Policy, b: Policy): boolean {
  return (
    a.autonomousLimitMinor === b.autonomousLimitMinor &&
    a.maxTransactionMinor === b.maxTransactionMinor &&
    a.dailyLimitMinor === b.dailyLimitMinor &&
    a.requireApprovalForNewSellers === b.requireApprovalForNewSellers &&
    a.autoCaptureMinConfidence === b.autoCaptureMinConfidence &&
    a.humanReviewMinConfidence === b.humanReviewMinConfidence &&
    canonicalCategories(a.allowedCategories).join() === canonicalCategories(b.allowedCategories).join()
  );
}

/** True when the form no longer shows what is saved — including a draft that cannot be read yet. */
export function isDraftDirty(validation: DraftValidation, saved: Policy): boolean {
  return validation.candidate === null || !policiesEqual(validation.candidate, saved);
}

/**
 * Advice about a policy that is valid but probably not what its author meant. Shown under the
 * field as a note; it never blocks saving.
 */
export function policyNotes(policy: Policy): FieldErrors {
  const notes: FieldErrors = {};
  if (policy.autonomousLimitMinor === 0) {
    notes.autonomousLimitMinor = "At $0.00 every purchase waits for your approval.";
  }
  if (policy.dailyLimitMinor < policy.maxTransactionMinor) {
    notes.dailyLimitMinor = `Lower than the per-transaction maximum, so the daily limit is what stops a purchase above ${formatMoney(policy.dailyLimitMinor)}.`;
  }
  if (canonicalCategories(policy.allowedCategories).length === 0) {
    notes.allowedCategories = "No category is allowed, so every purchase will be blocked.";
  }
  return notes;
}

/* -------------------------------------------------------------------------- */
/*  Failed requests                                                            */
/* -------------------------------------------------------------------------- */

export interface Failure {
  message: string;
  /** Quoted next to the message so a failure in the demo can be found in the server log. */
  requestId: string | null;
}

/** What to show for a rejected action. Anything that is not an API error gets a generic line, never its internals. */
export function toFailure(cause: unknown): Failure {
  if (cause instanceof ApiClientError) return { message: cause.message, requestId: cause.requestId };
  return { message: "Something went wrong. Try again.", requestId: null };
}

/* -------------------------------------------------------------------------- */
/*  Limit bands                                                                */
/* -------------------------------------------------------------------------- */

export interface SpendBand {
  id: "autonomous" | "approval" | "blocked";
  title: string;
  /** The amounts that fall in this band, e.g. "$100.01 – $1,000.00". */
  range: string;
  tone: "success" | "review" | "danger";
}

/**
 * The three things that can happen to a purchase by size alone. A band that no amount can fall
 * into (limits equal, or an autonomous limit of zero) is left out rather than shown empty.
 */
export function spendBands(policy: Pick<Policy, "autonomousLimitMinor" | "maxTransactionMinor">): SpendBand[] {
  const max = policy.maxTransactionMinor;
  // A draft may momentarily hold an autonomous limit above the maximum; the maximum wins, as in the engine.
  const autonomous = Math.min(policy.autonomousLimitMinor, max);
  const bands: SpendBand[] = [];
  if (autonomous > 0) {
    bands.push({ id: "autonomous", title: "Agent decides alone", range: `Up to ${formatMoney(autonomous)}`, tone: "success" });
  }
  if (max > autonomous) {
    bands.push({
      id: "approval",
      title: "You approve first",
      range: autonomous === 0 ? `Up to ${formatMoney(max)}` : `${formatMoney(autonomous + 1)} – ${formatMoney(max)}`,
      tone: "review",
    });
  }
  bands.push({ id: "blocked", title: "Always blocked", range: `Over ${formatMoney(max)}`, tone: "danger" });
  return bands;
}

/* -------------------------------------------------------------------------- */
/*  Daily spend meter                                                          */
/* -------------------------------------------------------------------------- */

export interface SpendMeter {
  /** Share of the limit already committed, 0–1 (1 when the limit is used up or exceeded). */
  ratio: number;
  remainingMinor: number;
  /** How far today's commitments already exceed the limit (possible after the limit is lowered). */
  overMinor: number;
  tone: "success" | "hold" | "danger";
}

const NEAR_LIMIT_RATIO = 0.8;

export function spendMeter(spentMinor: number, limitMinor: number): SpendMeter {
  const spent = Math.max(0, spentMinor);
  const limit = Math.max(0, limitMinor);
  const remainingMinor = Math.max(0, limit - spent);
  const ratio = limit === 0 ? 1 : Math.min(1, spent / limit);
  return {
    ratio,
    remainingMinor,
    overMinor: Math.max(0, spent - limit),
    tone: remainingMinor === 0 ? "danger" : ratio >= NEAR_LIMIT_RATIO ? "hold" : "success",
  };
}

/* -------------------------------------------------------------------------- */
/*  Verification thresholds                                                    */
/* -------------------------------------------------------------------------- */

export interface ConfidenceRule {
  id: "pass_high" | "pass_low" | "fail_high" | "fail_low" | "uncertain";
  when: string;
  then: string;
  tone: "success" | "review" | "danger";
}

/**
 * What the two thresholds mean for one required condition, in the order of
 * `decideVerification`: a confident pass counts toward capture, a confident fail is an explicit
 * failure, and everything in between goes to a human.
 */
export function confidenceRules(autoCapturePercent: number, humanReviewPercent: number): ConfidenceRule[] {
  const rules: ConfidenceRule[] = [
    { id: "pass_high", when: `Passes at ${autoCapturePercent}% or higher`, then: "Counts toward capture", tone: "success" },
  ];
  if (autoCapturePercent > 0) {
    rules.push({ id: "pass_low", when: `Passes below ${autoCapturePercent}%`, then: "A human decides", tone: "review" });
  }
  rules.push({
    id: "fail_high",
    when: humanReviewPercent === 0 ? "Fails at any confidence" : `Fails at ${humanReviewPercent}% or higher`,
    then: "Revision, or void when none remain",
    tone: "danger",
  });
  if (humanReviewPercent > 0) {
    rules.push({ id: "fail_low", when: `Fails below ${humanReviewPercent}%`, then: "A human decides", tone: "review" });
  }
  rules.push({ id: "uncertain", when: "Uncertain, or the AI verifier is unavailable", then: "A human decides", tone: "review" });
  return rules;
}

/* -------------------------------------------------------------------------- */
/*  "What would happen" preview                                                */
/* -------------------------------------------------------------------------- */

export interface ExampleDeal {
  id: "established-illustration" | "bilingual-copy" | "new-seller";
  title: string;
  amountMinor: number;
  category: Category;
  /**
   * Name and trust level of a seller from the demo directory. Spelled out here instead of
   * importing the directory, which would ship every seller's private rate card to the browser;
   * a unit test keeps the two in step.
   */
  seller: Pick<SellerProfile, "id" | "name" | "trust">;
}

export const EXAMPLE_DEALS: readonly ExampleDeal[] = [
  {
    id: "established-illustration",
    title: "Three landing-page illustrations",
    amountMinor: 4_700,
    category: "illustration",
    seller: { id: "northwind", name: "Northwind Studio", trust: "established" },
  },
  {
    id: "bilingual-copy",
    title: "Six product descriptions in English and Japanese",
    amountMinor: 18_000,
    category: "copywriting",
    seller: { id: "lingua", name: "Lingua Labs", trust: "established" },
  },
  {
    id: "new-seller",
    title: "Two hero illustrations",
    amountMinor: 1_800,
    category: "illustration",
    seller: { id: "pixelharbor", name: "Pixel Harbor", trust: "new" },
  },
];

export interface ExamplePreview {
  example: ExampleDeal;
  evaluation: PolicyEvaluation;
}

/** Run the real policy engine over the example deals. */
export function previewExamples(policy: Policy, spentTodayMinor: number, now: Date): ExamplePreview[] {
  return EXAMPLE_DEALS.map((example) => ({
    example,
    evaluation: evaluatePolicy(policy, {
      amountMinor: example.amountMinor,
      category: example.category,
      seller: example.seller,
      spentTodayMinor: Math.max(0, Math.trunc(spentTodayMinor)),
      now,
    }),
  }));
}

/** What the engine's outcome means for the money, in one sentence. */
export const POLICY_OUTCOME_CONSEQUENCE: Record<PolicyEvaluation["outcome"], string> = {
  allow: "The agent places the authorization hold on its own.",
  needs_approval: "PACT pauses and asks you before any hold is placed.",
  block: "The deal stops here. No PayPal call is made.",
};

/* -------------------------------------------------------------------------- */
/*  Delegated wallet                                                           */
/* -------------------------------------------------------------------------- */

export type WalletState = "connected" | "pending" | "shared" | "interactive" | "unsupported";

export interface WalletSummary {
  state: WalletState;
  title: string;
  description: string;
  tone: "success" | "info" | "review" | "neutral";
  /** Whether this session can start (or restart) its own connection. */
  canConnect: boolean;
  canDisconnect: boolean;
}

export function describeWallet(status: WalletStatus): WalletSummary {
  if (!status.supportsVault) {
    return {
      state: "unsupported",
      title: "Interactive approval only",
      description: "The active payment provider cannot hold a delegated wallet, so you approve every authorization yourself.",
      tone: "neutral",
      canConnect: false,
      canDisconnect: false,
    };
  }
  if (status.session.connected) {
    return {
      state: "connected",
      title: "Agent wallet connected",
      description: "In-policy deals are authorized without a PayPal login. Anything above your limits still waits for you.",
      tone: "success",
      canConnect: false,
      canDisconnect: true,
    };
  }
  if (status.session.pending) {
    return {
      state: "pending",
      title: "Connection not finished",
      description: "A PayPal consent was started but not completed. Start again to finish, or cancel it.",
      tone: "review",
      canConnect: true,
      canDisconnect: true,
    };
  }
  if (status.demo.connected) {
    return {
      state: "shared",
      title: "Using the shared demo wallet",
      description: "In-policy deals authorize through the operator’s shared sandbox wallet. Connect your own to use it instead.",
      tone: "info",
      canConnect: true,
      canDisconnect: false,
    };
  }
  return {
    state: "interactive",
    title: "Interactive approval",
    description: "No wallet is connected, so you approve each authorization in PayPal before the hold is placed.",
    tone: "neutral",
    canConnect: true,
    canDisconnect: false,
  };
}

/**
 * The consent link to navigate to, as an absolute http(s) URL (the simulator answers with a
 * path on this origin). Null for anything else: a `javascript:` link is never followed, even
 * though the value comes from our own API.
 */
export function resolveApproveUrl(approveUrl: string, origin: string): string | null {
  try {
    const url = new URL(approveUrl, origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Shown when the provider answers with a consent link that `resolveApproveUrl` refuses. */
export const UNUSABLE_APPROVE_URL: Failure = {
  message: "The payment provider returned an unusable approval link. Nothing was connected.",
  requestId: null,
};

export interface WalletNotice {
  kind: "success" | "error" | "info";
  title: string;
  description: string;
}

/** The message for `/policies?wallet=…`, where PayPal (or the simulator) sends the payer back. */
export function walletNotice(outcome: string | null): WalletNotice | null {
  switch (outcome) {
    case "connected":
      return {
        kind: "success",
        title: "Agent wallet connected",
        description: "In-policy deals now authorize without a PayPal login.",
      };
    case "cancelled":
      return {
        kind: "info",
        title: "Wallet connection cancelled",
        description: "Nothing was connected. Each authorization still needs your approval in PayPal.",
      };
    case "error":
      return {
        kind: "error",
        title: "The wallet could not be connected",
        description: "PayPal did not confirm the consent. Nothing was connected; you can try again.",
      };
    default:
      return null;
  }
}
