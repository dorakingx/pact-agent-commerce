/**
 * Fill the operations ledger with showcase deals — REAL deals, executed through the same step
 * engine, agents, policy engine and payment orchestrator as a visitor's deal, owned by "system".
 *
 *   npx tsx scripts/seed-showcase.ts [--count <n>] [--scenario <id>] [--dry-run]
 *
 *   --count <n>      how many deals to run (default 8); cycles through the demo scenarios
 *   --scenario <id>  only this scenario: happy-path | revision | approval | injection
 *   --dry-run        print the plan and the environment, execute nothing
 *
 * The script plays the human at every gate, as the demo operator: it approves the spend, and
 * at a delivery review it releases the payment — except in the hostile-delivery scenario, where
 * it rejects. Every such decision is recorded in the audit trail as the seed script's.
 *
 * Against PayPal Sandbox it needs the shared demo wallet (a delegated authorization): a script
 * cannot log in to PayPal to approve an order. Against the simulator it approves the simulated
 * order itself.
 *
 * .env.local and .env are read when present. Prints deal codes, statuses, amounts and PayPal
 * ids; never a credential. Exits non-zero when a deal ends in a state its scenario should not
 * end in. Engine logs are silenced unless PACT_LOG_SILENT=0 is set.
 *
 * With the local PGlite database, stop the dev server first: PGlite supports one process at a time.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { AdvanceResponse, CreateDealRequest, DealView, DecisionRequest, ReconciliationView } from "../src/lib/api/dto";
import { assertNever } from "../src/lib/domain/format";
import { formatMoney } from "../src/lib/domain/money";
import { SCENARIOS, type ScenarioId } from "../src/lib/domain/scenarios";
import type { HumanDecisionKind } from "../src/lib/domain/schemas";
import type { DealStatus } from "../src/lib/domain/status";
import type { ServiceContext } from "../src/lib/services/context";

/* -------------------------------------------------------------------------- */
/*  Plan                                                                       */
/* -------------------------------------------------------------------------- */

export const DEFAULT_COUNT = 8;
export const MAX_COUNT = 60;
export const OPERATOR_REASON = "Decided by the demo operator (seed script)";

/** Where each scenario is meant to end. Anything else is reported and fails the run. */
export const EXPECTED_STATUS: Record<ScenarioId, DealStatus> = {
  "happy-path": "completed",
  revision: "completed",
  approval: "completed",
  injection: "rejected",
};

/**
 * Requests per scenario: the scenario's own text first, then variations in subject, count,
 * formats and budget, so the ledger is not four identical rows. Each variation keeps what makes
 * its scenario end the way it should — the pinned seller's behaviour, a price on the same side
 * of the autonomous limit, a revision round where one is needed — and stays inside what both
 * the scripted and the AI intent parser read reliably.
 */
const VARIATIONS: Record<ScenarioId, readonly string[]> = {
  "happy-path": [
    "Get two onboarding illustrations for under $40 by tomorrow at 6 PM. I need both 16:9 and 1:1 versions and one revision.",
    "I need four feature illustrations for our pricing page, 16:9 only, within 3 days. Budget is $64, with one revision.",
  ],
  revision: [
    "I need 3 launch banner illustrations for our spring sale, each in 16:9 and 1:1, within 2 days. Budget is $48, with one revision.",
    "I need 2 social banner illustrations for our community meetup, each in 16:9 and 4:5, by tomorrow at 6 PM. Budget is $34, with one revision.",
  ],
  approval: [
    "Write 5 product descriptions for our new wireless headphone lineup, 80 to 120 words each, in English and Japanese, within 3 days. Budget is $190, with two revisions.",
    "Write 8 product descriptions for our new standing desk lineup, 60 to 100 words each, in English and Spanish, within 4 days. Budget is $270, with one revision.",
  ],
  injection: [
    "Three hero illustrations for a developer conference page, 16:9 only, within 48 hours. Maximum $60, one revision.",
    "Two cover illustrations for a fintech report, 16:9 and 1:1, within 72 hours. Maximum $50, one revision.",
  ],
};

export interface ShowcasePlan {
  scenarioId: ScenarioId;
  intent: string;
  expected: DealStatus;
}

function intentsOf(scenarioId: ScenarioId): string[] {
  const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  return [scenario.intent, ...VARIATIONS[scenarioId]];
}

/**
 * `count` deals, round-robin over the scenarios (or all of one scenario). A scenario's requests
 * are used in order and repeat only once all of them have been used.
 */
export function planShowcase(count: number, only: ScenarioId | null = null): ShowcasePlan[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new UsageError(`--count must be a whole number from 1 to ${MAX_COUNT}`);
  }
  const scenarioIds = only === null ? SCENARIOS.map((scenario) => scenario.id) : [only];
  return Array.from({ length: count }, (_, index) => {
    const scenarioId = scenarioIds[index % scenarioIds.length];
    const intents = intentsOf(scenarioId);
    const round = Math.floor(index / scenarioIds.length);
    return { scenarioId, intent: intents[round % intents.length], expected: EXPECTED_STATUS[scenarioId] };
  });
}

/* -------------------------------------------------------------------------- */
/*  Running one deal                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The parts of the service layer the script drives. Passed in rather than imported, because the
 * service modules can only be loaded once the process runs with the server condition (see the
 * bottom of this file) — and so that tests can drive the same runner with a test context.
 */
export interface SeedEngine {
  /** Owner of showcase deals (SYSTEM_OWNER): no browser session can ever act as it. */
  owner: string;
  createDeal(ctx: ServiceContext, actor: { sessionId: string; clientKey: string | null }, input: CreateDealRequest): Promise<DealView>;
  advanceDeal(ctx: ServiceContext, sessionId: string, dealId: string, appUrl: string): Promise<AdvanceResponse>;
  decideDeal(ctx: ServiceContext, sessionId: string, dealId: string, decision: DecisionRequest): Promise<DealView>;
  getDealView(ctx: ServiceContext, viewerSessionId: string | null, dealId: string): Promise<DealView>;
  approveSimulatedOrder(ctx: ServiceContext, sessionId: string | null, orderId: string): Promise<{ dealId: string }>;
  reconcile(ctx: ServiceContext, viewerSessionId: string | null, dealId: string, options: { narrate: boolean }): Promise<ReconciliationView>;
}

export interface ShowcaseResult {
  plan: ShowcasePlan;
  code: string | null;
  dealId: string | null;
  status: DealStatus | null;
  priceMinor: number | null;
  orderId: string | null;
  authorizationId: string | null;
  captureId: string | null;
  /** Result of re-reading the provider's record after the deal ended; null when not checked. */
  reconciliation: ReconciliationView["status"] | null;
  /** True when the deal ended where its scenario should end. */
  ok: boolean;
  /** Why the run stopped early, when it did. */
  problem: string | null;
}

export interface RunOptions {
  appUrl: string;
  tzOffsetMinutes: number;
  /** Called after every step, for progress output. */
  onStep?: (deal: DealView) => void;
  /**
   * How long to wait before retrying a step that stalled, one entry per consecutive stall.
   * When the list is used up the deal is reported instead of being retried further.
   */
  stallBackoffMs?: readonly number[];
}

/** A deal takes about fifteen steps; anything near this many is stuck, not slow. */
const MAX_STEPS = 80;
const BUSY_RETRY_MS = 250;
/**
 * A step that could not complete is retried by calling again — "after a pause, not in a tight
 * loop" (AdvanceResponse). The engine gives some payment steps only a few attempts before it
 * closes the deal, so retries a few milliseconds apart would spend them all inside one short
 * PayPal blip and turn it into a permanently failed showcase deal. These pauses outlast one.
 */
const STALL_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000];

class SeedProblem extends Error {}

function reviewDecision(scenarioId: ScenarioId): HumanDecisionKind {
  return scenarioId === "injection" ? "reject_delivery" : "release_payment";
}

async function decide(engine: SeedEngine, ctx: ServiceContext, deal: DealView, kind: HumanDecisionKind): Promise<DealView> {
  if (deal.next.kind !== "human" || !deal.next.options.includes(kind)) {
    throw new SeedProblem(`"${kind}" is not offered at this gate`);
  }
  return engine.decideDeal(ctx, engine.owner, deal.id, { kind, reason: OPERATOR_REASON });
}

/** The payer's approval. Only the simulator can be approved by a script. */
async function approvePayment(engine: SeedEngine, ctx: ServiceContext, deal: DealView): Promise<DealView> {
  const orderId = deal.payment?.orderId ?? null;
  if (ctx.provider.kind !== "simulated" || orderId === null) {
    throw new SeedProblem("the order needs a PayPal login; connect the shared demo wallet so it can be authorized by delegation");
  }
  await engine.approveSimulatedOrder(ctx, engine.owner, orderId);
  const after = await engine.getDealView(ctx, engine.owner, deal.id);
  if (after.status === "awaiting_payment") throw new SeedProblem("the simulated approval did not authorize the order");
  return after;
}

async function passGate(engine: SeedEngine, ctx: ServiceContext, plan: ShowcasePlan, deal: DealView): Promise<DealView> {
  if (deal.next.kind !== "human") return deal;
  switch (deal.next.gate) {
    case "approval":
      return decide(engine, ctx, deal, "approve_spend");
    case "payment":
      return approvePayment(engine, ctx, deal);
    case "review":
      return decide(engine, ctx, deal, reviewDecision(plan.scenarioId));
    default:
      return assertNever(deal.next.gate);
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The step ran into a problem and left the deal where it was: `lastError` says why, and the same step is still due. */
function stalled(advanced: AdvanceResponse): boolean {
  return advanced.executed === null && !advanced.busy && advanced.deal.next.kind === "auto" && advanced.deal.lastError !== null;
}

async function driveToEnd(engine: SeedEngine, ctx: ServiceContext, plan: ShowcasePlan, first: DealView, options: RunOptions): Promise<DealView> {
  const backoff = options.stallBackoffMs ?? STALL_BACKOFF_MS;
  let stalls = 0;
  let deal = first;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    options.onStep?.(deal);
    switch (deal.next.kind) {
      case "done":
        return deal;
      case "human":
        deal = await passGate(engine, ctx, plan, deal);
        break;
      case "auto": {
        const advanced = await engine.advanceDeal(ctx, engine.owner, deal.id, options.appUrl);
        deal = advanced.deal;
        if (advanced.busy) {
          await pause(BUSY_RETRY_MS);
        } else if (stalled(advanced)) {
          // Out of patience: leave the deal as it is (it can be advanced later) and say what held it up.
          if (stalls >= backoff.length) throw new SeedProblem(deal.lastError ?? `the "${deal.status}" step kept stalling`);
          await pause(backoff[stalls]);
          stalls += 1;
        } else {
          stalls = 0;
        }
        break;
      }
      default:
        return assertNever(deal.next);
    }
  }
  throw new SeedProblem(`still "${deal.status}" after ${MAX_STEPS} steps`);
}

function describeError(error: unknown): string {
  // Messages only: an error object can carry request details that do not belong in a terminal.
  return error instanceof Error ? error.message : String(error);
}

function resultOf(plan: ShowcasePlan, deal: DealView | null, extra: Pick<ShowcaseResult, "reconciliation" | "problem">): ShowcaseResult {
  return {
    plan,
    code: deal?.code ?? null,
    dealId: deal?.id ?? null,
    status: deal?.status ?? null,
    priceMinor: deal?.contract?.contract.price.amountMinor ?? null,
    orderId: deal?.payment?.orderId ?? null,
    authorizationId: deal?.payment?.authorizationId ?? null,
    captureId: deal?.payment?.captureId ?? null,
    reconciliation: extra.reconciliation,
    ok: extra.problem === null && deal?.status === plan.expected,
    problem: extra.problem,
  };
}

/**
 * Create one deal and drive it to its end, playing the operator at the gates. Never throws for a
 * deal that goes wrong: the result says where it stopped and why, and the run goes on.
 */
export async function runShowcaseDeal(engine: SeedEngine, ctx: ServiceContext, plan: ShowcasePlan, options: RunOptions): Promise<ShowcaseResult> {
  let deal: DealView | null = null;
  try {
    deal = await engine.createDeal(
      ctx,
      { sessionId: engine.owner, clientKey: null },
      { intent: plan.intent, scenarioId: plan.scenarioId, tzOffsetMinutes: options.tzOffsetMinutes },
    );
    deal = await driveToEnd(engine, ctx, plan, deal, options);
  } catch (error) {
    const latest = deal === null ? null : await engine.getDealView(ctx, engine.owner, deal.id).catch(() => deal);
    return resultOf(plan, latest, { reconciliation: null, problem: describeError(error) });
  }
  // The deal is over; comparing it with the provider's record adds the "reconciled" ledger entry.
  const hasOrder = (deal.payment?.orderId ?? null) !== null;
  const reconciliation = hasOrder
    ? await engine.reconcile(ctx, engine.owner, deal.id, { narrate: false }).then(
        (view) => view.status,
        () => "unavailable" as const,
      )
    : null;
  // A deal that ended somewhere else usually says why itself (a payment failure, a blocked capture).
  const problem = deal.status === plan.expected ? null : deal.lastError;
  return resultOf(plan, deal, { reconciliation, problem });
}

/* -------------------------------------------------------------------------- */
/*  Output                                                                     */
/* -------------------------------------------------------------------------- */

const COLUMNS = ["Code", "Scenario", "Final status", "Price", "Order", "Authorization", "Capture", "Check", "Result"] as const;

function cells(result: ShowcaseResult): string[] {
  const outcome = result.ok ? "ok" : `UNEXPECTED (wanted ${result.plan.expected}${result.problem === null ? "" : `: ${result.problem}`})`;
  return [
    result.code ?? "—",
    result.plan.scenarioId,
    result.status ?? "not created",
    result.priceMinor === null ? "—" : formatMoney(result.priceMinor),
    result.orderId ?? "—",
    result.authorizationId ?? "—",
    result.captureId ?? "—",
    result.reconciliation ?? "—",
    outcome,
  ];
}

/** A plain fixed-width table: one row per deal. */
export function formatResults(results: readonly ShowcaseResult[]): string {
  const rows = [[...COLUMNS], ...results.map(cells)];
  const widths = COLUMNS.map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const line = (row: string[]): string => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  return [line(rows[0]), widths.map((width) => "-".repeat(width)).join("  "), ...rows.slice(1).map(line)].join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Command line                                                               */
/* -------------------------------------------------------------------------- */

export class UsageError extends Error {}

export interface SeedArgs {
  count: number;
  scenario: ScenarioId | null;
  dryRun: boolean;
}

const USAGE = "usage: npx tsx scripts/seed-showcase.ts [--count <n>] [--scenario <id>] [--dry-run]";

function scenarioIdOf(value: string | undefined): ScenarioId {
  const scenario = SCENARIOS.find((candidate) => candidate.id === value);
  if (!scenario) throw new UsageError(`--scenario must be one of: ${SCENARIOS.map((candidate) => candidate.id).join(", ")}`);
  return scenario.id;
}

function countOf(value: string | undefined): number {
  if (value === undefined || !/^\d{1,3}$/.test(value)) throw new UsageError(`--count must be a whole number from 1 to ${MAX_COUNT}`);
  return Number(value);
}

export function parseArgs(argv: readonly string[]): SeedArgs {
  const args: SeedArgs = { count: DEFAULT_COUNT, scenario: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--count":
        args.count = countOf(argv[(index += 1)]);
        break;
      case "--scenario":
        args.scenario = scenarioIdOf(argv[(index += 1)]);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${flag}`);
    }
  }
  // Validates the count against the same bounds the plan enforces.
  planShowcase(args.count, args.scenario);
  return args;
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Server modules import the `server-only` marker package, which only resolves to a no-op under
 * Node's "react-server" export condition — the condition Next.js runs server code with. A plain
 * `tsx scripts/seed-showcase.ts` lacks it, so the script starts itself again with it.
 */
const SERVER_CONDITION = "--conditions=react-server";

function hasServerCondition(): boolean {
  return process.execArgv.includes(SERVER_CONDITION) || (process.env.NODE_OPTIONS ?? "").includes(SERVER_CONDITION);
}

function restartWithServerCondition(): never {
  const child = spawnSync(process.execPath, [...process.execArgv, SERVER_CONDITION, ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}

function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // The file is optional; variables may just as well come from the shell.
    }
  }
}

const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function loadEngine(): Promise<SeedEngine> {
  const [deals, auditor, session] = await Promise.all([
    import("../src/lib/services/deals"),
    import("../src/lib/services/auditor"),
    import("../src/lib/services/session"),
  ]);
  return {
    owner: session.SYSTEM_OWNER,
    createDeal: deals.createDeal,
    advanceDeal: deals.advanceDeal,
    decideDeal: deals.decideDeal,
    getDealView: deals.getDealView,
    approveSimulatedOrder: deals.approveSimulatedOrder,
    reconcile: auditor.reconcileWithPayPal,
  };
}

/**
 * Null when the run can proceed; otherwise what the operator has to do first. PayPal Sandbox
 * needs the shared demo wallet, because every order would otherwise wait for a PayPal login.
 */
export async function missingPrerequisite(ctx: ServiceContext): Promise<string | null> {
  if (ctx.provider.kind !== "paypal_sandbox") return null;
  const { getWalletStatus } = await import("../src/lib/services/wallet");
  if ((await getWalletStatus(ctx, null)).demo.connected) return null;
  return [
    "Seeding against PayPal Sandbox needs the shared demo wallet: a script cannot log in to PayPal to approve an order.",
    'Connect it once as the operator: POST /api/wallet/connect {"scope":"demo"} with the x-admin-token header, then approve in PayPal.',
  ].join("\n");
}

/** Read from configuration alone, so a dry run never opens the database. */
async function describeEnvironment(): Promise<string> {
  const [{ getAiMode, getPaymentMode }, { databaseKind }] = await Promise.all([import("../src/lib/config"), import("../src/lib/db")]);
  const local = process.env.PGLITE_DIR?.trim() ? "pglite (directory)" : "pglite (in memory: nothing will persist)";
  return `payments: ${getPaymentMode()} · agents: ${getAiMode()} · database: ${databaseKind() === "pglite" ? local : "postgres"}`;
}

function printPlan(plans: readonly ShowcasePlan[]): void {
  for (const [index, plan] of plans.entries()) {
    say(`${String(index + 1).padStart(2)}. ${plan.scenarioId} → ${plan.expected}: ${plan.intent}`);
  }
}

async function seed(ctx: ServiceContext, plans: readonly ShowcasePlan[], appUrl: string): Promise<number> {
  const missing = await missingPrerequisite(ctx);
  if (missing !== null) {
    say(missing);
    return 1;
  }
  const engine = await loadEngine();
  const options: RunOptions = { appUrl, tzOffsetMinutes: new Date().getTimezoneOffset() };
  const results: ShowcaseResult[] = [];
  for (const [index, plan] of plans.entries()) {
    const position = `[${index + 1}/${plans.length}]`;
    say(`${position} ${plan.scenarioId} …`);
    const result = await runShowcaseDeal(engine, ctx, plan, options);
    say(`${position} ${result.code ?? "—"} ${result.status ?? "not created"}${result.ok ? "" : " — UNEXPECTED"}`);
    results.push(result);
  }
  process.stdout.write(`${formatResults(results)}\n`);
  const unexpected = results.filter((result) => !result.ok).length;
  if (unexpected > 0) say(`${unexpected} of ${results.length} deals did not end where their scenario should.`);
  return unexpected === 0 ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const plans = planShowcase(args.count, args.scenario);
  loadEnvFiles();
  // The table on stdout is the product; the engine's JSON log lines would drown it.
  process.env.PACT_LOG_SILENT ??= "1";

  say(await describeEnvironment());
  if (args.dryRun) {
    printPlan(plans);
    say("Dry run: nothing was executed.");
    return 0;
  }
  const [{ getServiceContext }, { getAppUrl }, { closeDb }] = await Promise.all([
    import("../src/lib/services/context"),
    import("../src/lib/config"),
    import("../src/lib/db"),
  ]);
  try {
    return await seed(await getServiceContext(), plans, getAppUrl());
  } finally {
    await closeDb();
  }
}

/** True only when this file is the program being run — not when a test imports it. */
const isEntryPoint = path.basename(process.argv[1] ?? "") === "seed-showcase.ts";

if (isEntryPoint) {
  if (!hasServerCondition()) restartWithServerCondition();
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      say(error instanceof UsageError ? `${error.message}\n${USAGE}` : `Seeding failed: ${describeError(error)}`);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}
