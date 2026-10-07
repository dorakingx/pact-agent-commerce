/**
 * The dashboard's agent harness: AG Studio's five built-in agents plus PACT's own.
 *
 * Studio's lead agent fronts every conversation and delegates. It normally knows four
 * specialists (planning, data, page, widget); here it is re-declared with a fifth target, the
 * "PACT auditor", and with a paragraph telling it when to hand off. The built-ins keep their own
 * instructions and tools, so everything Studio's agents can do to a dashboard still works.
 *
 * Every agent runs Studio's own loop in the browser (directLlmRunner) against one adapter, and
 * that adapter only ever talks to PACT's proxy route.
 */
import {
  createAiHarness,
  directLlmRunner,
  type AgAiHarness,
  type AgAiModel,
  type AgAiTelemetryObserver,
  type AgBuiltInAgentId,
  type AgLlmAdapter,
  type AgStudioApi,
} from "ag-studio";
import type { OpsAiModel } from "@/lib/client/studio-ai-contract";
import { AUDITOR_AGENT_ID, AUDITOR_AGENT_NAME, LEAD_ADDENDUM, PROMPT_STARTERS, auditorInstructions } from "@/lib/client/studio-agent";
import type { PactStudioContext } from "../context";
import { createAuditorTools } from "./tools";

const SPECIALISTS = ["planning", "data", "page", "widget"] as const satisfies readonly AgBuiltInAgentId[];
const DELEGATE_TOOL = "delegate_to";
/**
 * Naming a conversation costs the lead a model round of its own before it starts on the request.
 * A dashboard question is better answered a few seconds sooner than filed under a title.
 */
const RENAME_TOOL = "rename_thread";

/** The auditor answers in a handful of rounds or not at all: a runaway loop is cut short. */
const AUDITOR_MAX_TURNS = 10;

export interface PactHarnessOptions {
  adapter: AgLlmAdapter;
  context: PactStudioContext;
  /** Models offered in the chat panel's picker, default first. */
  models: readonly OpsAiModel[];
  observer?: AgAiTelemetryObserver;
}

/** Reasoning effort is offered only where the provider has such a dial. */
function pickerModels(models: readonly OpsAiModel[]): AgAiModel[] {
  return models.map((model) =>
    model.id.startsWith("openai/")
      ? {
          ...model,
          efforts: [
            { id: "low", label: "Balanced" },
            { id: "minimal", label: "Fastest" },
            { id: "medium", label: "Thorough" },
          ],
        }
      : { ...model },
  );
}

export function createPactHarness(api: AgStudioApi, options: PactHarnessOptions): AgAiHarness {
  const { adapter, context } = options;
  const auditorTools = createAuditorTools(api, context);

  return createAiHarness(api, ({ builtIn }) => {
    const lead = builtIn.lead;
    return {
      agents: [
        directLlmRunner({
          ...lead,
          adapter,
          instructions: (ctx, params) => `${lead.instructions?.(ctx, params) ?? ""}\n\n${LEAD_ADDENDUM}`,
          // The built-in lead can only delegate to Studio's own four; swap that one tool for a wider one.
          tools: (ctx, params) => [
            ...(lead.tools?.(ctx, params) ?? []).filter((tool) => tool.name !== DELEGATE_TOOL && tool.name !== RENAME_TOOL),
            ctx.tools.delegateTo([...SPECIALISTS, AUDITOR_AGENT_ID]),
          ],
        }),
        ...SPECIALISTS.map((id) => directLlmRunner({ ...builtIn[id], adapter })),
        directLlmRunner({
          id: AUDITOR_AGENT_ID,
          name: AUDITOR_AGENT_NAME,
          description:
            "Read-only specialist for questions about deals: which need a human or are at risk, why a deal was or was not captured (failed conditions, evidence, policy flags), and reconciling a deal with PayPal. Give it the user's question in full.",
          // No delegation parameters: the question arrives as the delegated message.
          schema: (s) => s.undefined(),
          adapter,
          instructions: () => auditorInstructions(context.snapshot()),
          tools: () => auditorTools,
          maxTurns: AUDITOR_MAX_TURNS,
        }),
      ],
      primary: "lead",
      models: pickerModels(options.models),
      promptStarters: PROMPT_STARTERS.map((starter) => ({ ...starter })),
      observers: options.observer ? [options.observer] : [],
    };
  });
}
