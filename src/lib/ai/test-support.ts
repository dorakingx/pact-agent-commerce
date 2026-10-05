/**
 * Test doubles and fixtures for the agent modules. Imported only by *.test.ts files.
 *
 * `stubCall` stands in for the model gateway. It parses the canned output with the caller's own
 * schema, exactly as the real gateway would, so a test can never feed an agent a shape the
 * provider could not have produced.
 */
import type { ModelMessage } from "ai";
import type {
  Contract,
  CopyArtifact,
  DeliverableSpec,
  IllustrationArtifact,
  Mandate,
  NegotiationMove,
  Submission,
  Terms,
  VerificationRule,
} from "../domain/schemas";
import { AiUnavailableError, type AiFailureReason, type CallStructured, type StructuredCall } from "./gateway";

export const TEST_NOW = new Date("2026-10-06T05:00:00.000Z");
export const TEST_MODEL = "test/stub-model";

export interface CallStub {
  call: CallStructured;
  /** Every request the agent under test made, in order. */
  calls: StructuredCall<unknown>[];
}

/** A gateway that answers each call with whatever `respond(call)` returns. */
export function respondingCall(respond: (call: StructuredCall<unknown>) => unknown): CallStub {
  const calls: StructuredCall<unknown>[] = [];
  const call: CallStructured = async <T>(request: StructuredCall<T>) => {
    const seen = request as StructuredCall<unknown>;
    calls.push(seen);
    return { output: request.schema.parse(respond(seen)), model: TEST_MODEL, latencyMs: 12, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  return { call, calls };
}

/** A gateway that answers every call with the same `output`. */
export function stubCall(output: unknown): CallStub {
  return respondingCall(() => output);
}

/** A gateway that fails every call the way the real one does. */
export function failingCall(reason: AiFailureReason): CallStub {
  const calls: StructuredCall<unknown>[] = [];
  const call: CallStructured = async <T>(request: StructuredCall<T>) => {
    calls.push(request as StructuredCall<unknown>);
    throw new AiUnavailableError(reason, `AI call failed (${reason})`);
  };
  return { call, calls };
}

/** A gateway that fails with an arbitrary (non-AI) error, to prove such errors are not swallowed. */
export function throwingCall(error: Error): CallStub {
  const calls: StructuredCall<unknown>[] = [];
  const call: CallStructured = async <T>(request: StructuredCall<T>) => {
    calls.push(request as StructuredCall<unknown>);
    throw error;
  };
  return { call, calls };
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

/** All user-visible text of a request: the prompt, or the text parts of its messages. */
export function userText(request: StructuredCall<unknown>): string {
  return request.prompt ?? (request.messages ?? []).map(messageText).join("\n");
}

export function terms(overrides: Partial<Terms> = {}): Terms {
  return { priceMinor: 5300, deadline: "2026-10-07T05:00:00.000Z", revisionLimit: 1, count: 3, ...overrides };
}

export function move(
  seq: number,
  actor: NegotiationMove["actor"],
  action: NegotiationMove["action"],
  moveTerms: Terms | null,
  message: string,
  guardrails: NegotiationMove["guardrails"] = [],
): NegotiationMove {
  return {
    seq,
    actor,
    action,
    terms: moveTerms,
    message,
    guardrails,
    source: "scripted",
    model: null,
    latencyMs: null,
    createdAt: TEST_NOW.toISOString(),
  };
}

export const ILLUSTRATION_SPEC: DeliverableSpec = {
  kind: "illustration",
  count: 3,
  aspectRatios: ["16:9", "1:1"],
  subject: "landing-page illustrations",
  style: null,
};

export const COPY_SPEC: DeliverableSpec = {
  kind: "copy",
  count: 2,
  languages: ["en", "ja"],
  minWords: 80,
  maxWords: 120,
  subject: "espresso machine lineup product descriptions",
  tone: null,
};

export function mandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    summary: "Three landing-page illustrations in 16:9 and 1:1",
    category: "illustration",
    deliverable: ILLUSTRATION_SPEC,
    minCount: 3,
    budgetMinor: 5000,
    deadline: "2026-10-07T09:00:00.000Z",
    revisionsWanted: 1,
    minRevisions: 1,
    notes: [],
    ...overrides,
  };
}

export function rule(id: string, kind: VerificationRule["kind"], description: string): VerificationRule {
  return { id, kind, description, required: true, evaluator: "ai" };
}

export function contract(deliverable: DeliverableSpec, rules: VerificationRule[]): Contract {
  return {
    contractId: "ctr_test0000001",
    schemaVersion: 1,
    dealId: "deal_test",
    createdAt: TEST_NOW.toISOString(),
    title: `${deliverable.count} pieces · ${deliverable.subject}`,
    category: deliverable.kind === "illustration" ? "illustration" : "copywriting",
    buyer: { id: "buyer-agent", name: "Buyer Agent" },
    seller: { id: "northwind", name: "Northwind Studio" },
    price: { amountMinor: 4800, currency: "USD" },
    deadline: "2026-10-07T09:00:00.000Z",
    revisionLimit: 1,
    deliverables: [deliverable],
    verificationRules: rules,
    settlement: {
      trigger: "verified_delivery",
      autoCaptureMinConfidence: 0.85,
      humanReviewMinConfidence: 0.5,
      onExhaustedRevisions: "void_authorization",
    },
  };
}

export function submission(artifacts: Submission["artifacts"], note = "Delivered as agreed."): Submission {
  return {
    id: "sub_test",
    dealId: "deal_test",
    round: 1,
    artifacts,
    note,
    source: "scripted",
    model: null,
    submittedAt: TEST_NOW.toISOString(),
  };
}

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900">
  <rect width="1600" height="900" fill="#0f172a"/>
  <circle cx="400" cy="450" r="180" fill="#38bdf8"/>
  <rect x="800" y="260" width="520" height="380" rx="24" fill="#f8fafc"/>
  <path d="M840 560 L960 420 L1080 500 L1280 320" stroke="#22c55e" stroke-width="16" fill="none"/>
</svg>`;

export function illustration(index: number, aspectRatio: string, overrides: Partial<IllustrationArtifact> = {}): IllustrationArtifact {
  const square = aspectRatio === "1:1";
  return {
    id: `art_${index}_${aspectRatio.replace(":", "x")}`,
    kind: "illustration",
    index,
    title: `Illustration ${index}`,
    aspectRatio,
    width: square ? 1200 : 1600,
    height: square ? 1200 : 900,
    format: "svg",
    svg: SAMPLE_SVG,
    description: "A dashboard card with a rising chart beside a blue circle.",
    ...overrides,
  };
}

export function copy(index: number, language: string, text: string, overrides: Partial<CopyArtifact> = {}): CopyArtifact {
  return { id: `txt_${index}_${language}`, kind: "copy", index, title: `Piece ${index}`, language, text, ...overrides };
}
