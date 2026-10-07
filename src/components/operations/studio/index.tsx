"use client";

/**
 * Agent Commerce Operations as an AG Studio dashboard.
 *
 * `StudioDashboard` takes the operations snapshot the host page already polls and turns it into
 * a Studio report: four designed pages over a small relational model, three PACT widgets
 * registered next to Studio's own, a theme bound to the app's design tokens, an editor a visitor
 * can rearrange (and whose state survives a reload), and Studio's agent framework with a
 * read-only PACT agent added to its team.
 *
 * It is a client-only component: the host loads it with `next/dynamic` and `ssr: false`.
 */
import {
  AgStudioAiModule,
  enableStudioDevValidations,
  type AgAiHarnessSetup,
  type AgAiTelemetryObserver,
  type AgReportState,
  type AgStudioApi,
  type AgStudioApiReadyEvent,
  type AgStudioErrorRaisedEvent,
  type AgStudioStateUpdatedEvent,
} from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { Callout } from "@/components/ui/callout";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import type { OpsSnapshot } from "@/lib/api/dto";
import { fetcher } from "@/lib/client/api";
import { AGENT_INPUT_PLACEHOLDER, AGENT_INTRO, AUDITOR_AGENT_ID, AUDITOR_AGENT_NAME } from "@/lib/client/studio-agent";
import { createAgentRunTracker, describeAgentRun, type AgentRunSummary } from "@/lib/client/studio-agent-telemetry";
import { OPS_AI_DEFAULT_MODEL, OPS_AI_ENDPOINT, OPS_AI_MODELS, type OpsAiStatus } from "@/lib/client/studio-ai-contract";
import { buildStudioRows, studioRowsFingerprint } from "@/lib/client/studio-data";
import { createOpsLlmAdapter } from "@/lib/client/studio-llm-adapter";
import { buildStudioDataSources } from "@/lib/client/studio-model";
import { withNewPage, withSelectedPage, withoutPage } from "@/lib/client/studio-pages";
import { clearStoredReport, exportFileName, loadStoredReport, saveStoredReport, serializeReport } from "@/lib/client/studio-persistence";
import { CANVAS_MIN_WIDTH, buildDefaultReport } from "@/lib/client/studio-report";
import { createPactHarness } from "./agent/harness";
import { PACT_TOOL_DISPLAY } from "./agent/tool-display";
import { CompactView } from "./compact-view";
import { createStudioContextHandle } from "./context";
import { StudioErrorBoundary } from "./error-boundary";
import { HeaderStrip } from "./header-strip";
import "./studio.css";
import { pactStudioTheme } from "./theme";
import { createPactWidgets, type PactRegistry } from "./widgets/definitions";

// Studio's extended configuration checks: worth their cost while developing, not in a visitor's bundle path.
if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

type ReportState = AgReportState<PactRegistry>;
type StudioApi = AgStudioApi<PactRegistry>;

const MODULES = [AgStudioAiModule];
const LICENSE_KEY = process.env.NEXT_PUBLIC_AG_LICENSE_KEY?.trim() || undefined;

/** Below this the editor's canvas (720px minimum) and its panels no longer fit. */
const EDITOR_QUERY = "(min-width: 768px)";
/** From here up the page is wide enough to hold the canvas at its comfortable width. */
const ROOMY_QUERY = "(min-width: 1180px)";
/** Pause after the last change before the layout is written, so a drag is one write, not sixty. */
const SAVE_DELAY_MS = 400;

const STUDIO_STYLE = { height: "100%", width: "100%" } as const;
const WRAPPER_STYLE = {
  // Tall enough for a page of widgets, never taller than the viewport minus the app's own chrome.
  height: "clamp(640px, calc(100dvh - 220px), 1200px)",
  "--pact-agent-intro": JSON.stringify(AGENT_INTRO),
} as React.CSSProperties;

const LAYOUT = {
  comfortable: { minWidth: CANVAS_MIN_WIDTH.comfortable },
  compact: { minWidth: CANVAS_MIN_WIDTH.compact },
} as const;

/** The chat on the left, the editor's own panels on the right, the report between them. */
const PANELS = { edit: { left: ["ai" as const], right: ["filters" as const, "edit" as const, "data" as const] } };

const LOCALE_TEXT = {
  panelTitleAi: "PACT agents",
  aiMessageInputPlaceholder: AGENT_INPUT_PLACEHOLDER,
  aiNewChat: "New conversation",
  // A total is the natural reading of a summed measure, so its name needs no suffix: "Captured",
  // not "Captured (sum)". Every other aggregation keeps Studio's suffix.
  aggregationSumFieldName: "${name}",
};

export interface StudioDashboardProps {
  snapshot: OpsSnapshot;
  onOpenDeal: (dealId: string) => void;
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Whether a media query matches, kept current. The dashboard is client-only, so there is no server answer to agree with. */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}

export default function StudioDashboard(props: StudioDashboardProps) {
  const wide = useMediaQuery(EDITOR_QUERY);
  if (!wide) return <CompactView {...props} />;
  return (
    <StudioErrorBoundary onResetLayout={() => clearStoredReport(browserStorage())}>
      <AgentGate {...props} />
    </StudioErrorBoundary>
  );
}

/**
 * Studio reads its agent harness once, when it is constructed. Whether there is a model to talk
 * to is something only the server knows, so the editor mounts after that one question is
 * answered — with the agents, or without them and with the reason shown.
 */
function AgentGate(props: StudioDashboardProps) {
  const { data, error, isLoading } = useSWR<OpsAiStatus>(OPS_AI_ENDPOINT, fetcher, { revalidateOnFocus: false, shouldRetryOnError: false });
  if (isLoading) {
    return (
      <div data-testid="studio-starting" role="status" aria-label="Starting the dashboard" className="flex flex-col gap-3">
        <Skeleton className="h-[92px] rounded-card" />
        <Skeleton className="h-[640px] rounded-card" />
      </div>
    );
  }
  const agents: OpsAiStatus = data ?? {
    available: false,
    reason: null,
    message: error ? "The dashboard agents could not be reached, so the chat is off." : "The dashboard agents are off.",
    models: OPS_AI_MODELS,
    defaultModel: OPS_AI_DEFAULT_MODEL,
  };
  return <StudioWorkspace {...props} agents={agents} />;
}

interface ViewState {
  pages: string[];
  selectedPageId: string;
  agentsOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

function viewOf(state: ReportState, api: StudioApi | null): ViewState {
  const history = api?.getHistory();
  return {
    pages: state.pages.map((page) => page.id),
    selectedPageId: state.selectedPageId,
    agentsOpen: state.panels?.ai?.collapsed === false,
    canUndo: (history?.undo.length ?? 0) > 0,
    canRedo: (history?.redo.length ?? 0) > 0,
  };
}

function sameView(a: ViewState, b: ViewState): boolean {
  return (
    a.selectedPageId === b.selectedPageId &&
    a.agentsOpen === b.agentsOpen &&
    a.canUndo === b.canUndo &&
    a.canRedo === b.canRedo &&
    a.pages.length === b.pages.length &&
    a.pages.every((id, index) => id === b.pages[index])
  );
}

function StudioWorkspace({ snapshot, onOpenDeal, agents }: StudioDashboardProps & { agents: OpsAiStatus }) {
  /* ------------------------------ application context ----------------------------- */
  const [{ context, update }] = useState(() => createStudioContextHandle({ snapshot, onOpenDeal }));
  // A layout effect, so the context is current before Studio's widgets react to the new data.
  useLayoutEffect(() => update({ snapshot, onOpenDeal }), [update, snapshot, onOpenDeal]);

  /* ------------------------------------- data ------------------------------------- */
  // A poll that brought nothing new must not hand Studio a new `data` object: every widget
  // would re-query and redraw. The rows are fingerprinted and the previous object is kept.
  const rows = useMemo(() => buildStudioRows(snapshot), [snapshot]);
  const fingerprint = useMemo(() => studioRowsFingerprint(rows), [rows]);
  const [current, setCurrent] = useState(() => ({ fingerprint, data: buildStudioDataSources(rows) }));
  if (current.fingerprint !== fingerprint) setCurrent({ fingerprint, data: buildStudioDataSources(rows) });

  /* ----------------------------------- report state ------------------------------- */
  const [initialState] = useState<ReportState>(() => (loadStoredReport(browserStorage()) ?? buildDefaultReport()) as ReportState);
  const [api, setApi] = useState<StudioApi | null>(null);
  const [view, setView] = useState<ViewState>(() => viewOf(initialState, null));
  const [pendingSave, setPendingSave] = useState<ReportState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const onApiReady = useCallback((event: AgStudioApiReadyEvent) => setApi(event.api as StudioApi), []);

  const onStateUpdated = useCallback(
    (event: AgStudioStateUpdatedEvent) => {
      const state = event.state as ReportState;
      setView((previous) => {
        const next = viewOf(state, event.api as StudioApi);
        return sameView(previous, next) ? previous : next;
      });
      setPendingSave(state);
    },
    [],
  );

  useEffect(() => {
    if (pendingSave === null) return;
    const timer = window.setTimeout(() => saveStoredReport(browserStorage(), pendingSave, new Date()), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pendingSave]);

  const onErrorRaised = useCallback((event: AgStudioErrorRaisedEvent) => {
    // Only what stops the report from loading is worth interrupting for; Studio repairs the rest itself.
    if (event.fatal) setProblem(event.errorDetails[0] ?? "The report could not be loaded.");
  }, []);

  const apply = useCallback(
    (change: (state: ReportState) => ReportState) => {
      if (api === null) return;
      const state = api.getState();
      const next = change(state);
      if (next !== state) api.setState(next);
    },
    [api],
  );

  const selectPage = useCallback((pageId: string) => apply((state) => withSelectedPage(state, pageId)), [apply]);
  const addPage = useCallback(() => apply((state) => withNewPage(state)), [apply]);
  const removePage = useCallback((pageId: string) => apply((state) => withoutPage(state, pageId)), [apply]);
  const toggleAgents = useCallback(
    () => apply((state) => ({ ...state, panels: { ...state.panels, ai: { ...state.panels?.ai, collapsed: state.panels?.ai?.collapsed === false } } })),
    [apply],
  );

  const reset = useCallback(() => {
    if (api === null) return;
    // Loaded through setState, so it is one more step in Studio's history and can be undone.
    api.setState(buildDefaultReport() as ReportState);
    setProblem(null);
    toast.success("Dashboard reset to the PACT default", {
      description: "Your previous layout is one undo away.",
      action: { label: "Undo", onClick: () => api.undo() },
    });
  }, [api]);

  const exportLayout = useCallback(() => {
    if (api === null) return;
    const now = new Date();
    const url = URL.createObjectURL(new Blob([serializeReport(api.getState(), now)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(now);
    link.click();
    URL.revokeObjectURL(url);
    toast.success("Report layout exported", { description: link.download });
  }, [api]);

  /* ------------------------------------- agents ----------------------------------- */
  const [adapter] = useState(() => createOpsLlmAdapter({ endpoint: OPS_AI_ENDPOINT, defaultModel: agents.defaultModel }));
  const [run, setRun] = useState<{ running: boolean; last: AgentRunSummary | null }>({ running: false, last: null });
  const [observer] = useState<AgAiTelemetryObserver>(() => {
    const tracker = createAgentRunTracker();
    return {
      onEvent(event) {
        const finished = tracker.observe(event);
        // Called inside the agent loop: record and return, nothing slow.
        setRun((previous) => {
          const running = tracker.running();
          if (finished === null && previous.running === running) return previous;
          return { running, last: finished ?? previous.last };
        });
      },
    };
  });
  const ai = useMemo<AgAiHarnessSetup | undefined>(
    () =>
      agents.available ? ({ api: studioApi }) => createPactHarness(studioApi, { adapter, context, models: agents.models, observer }) : undefined,
    [agents.available, agents.models, adapter, context, observer],
  );
  const widgets = useMemo(() => createPactWidgets(context), [context]);
  const layout = useMediaQuery(ROOMY_QUERY) ? LAYOUT.comfortable : LAYOUT.compact;

  const agentControls = agents.available
    ? {
        state: "available" as const,
        open: view.agentsOpen,
        onToggle: toggleAgents,
        running: run.running,
        activity:
          run.last === null ? null : `Last request: ${describeAgentRun(run.last, (id) => (id === AUDITOR_AGENT_ID ? AUDITOR_AGENT_NAME : `${id} agent`))}`,
      }
    : { state: "unavailable" as const, message: agents.message ?? "The dashboard agents are off." };

  return (
    <Tabs value={view.selectedPageId} onValueChange={selectPage} className="gap-3" data-testid="studio-dashboard">
      <HeaderStrip
        pages={view.pages}
        selectedPageId={view.selectedPageId}
        onAddPage={addPage}
        onRemovePage={removePage}
        canUndo={view.canUndo}
        canRedo={view.canRedo}
        onUndo={() => api?.undo()}
        onRedo={() => api?.redo()}
        onReset={reset}
        onExport={exportLayout}
        ready={api !== null}
        generatedAt={snapshot.generatedAt}
        trial={LICENSE_KEY === undefined}
        agents={agentControls}
      />
      {problem === null ? null : (
        <Callout tone="warning" title="This saved layout could not be loaded completely" data-testid="studio-problem">
          {problem} Use “Reset to PACT default” to start again from the designed report.
        </Callout>
      )}
      {/* One panel for every tab: Studio swaps the page inside it, so it is never unmounted. */}
      <TabsContent value={view.selectedPageId} forceMount className="pact-studio" style={WRAPPER_STYLE} data-testid="studio-canvas">
        <AgStudioProvider modules={MODULES} licenseKey={LICENSE_KEY}>
          <AgStudio<PactRegistry>
            style={STUDIO_STYLE}
            data={current.data}
            mode="edit"
            theme={pactStudioTheme}
            initialState={initialState}
            widgets={widgets}
            context={context}
            panels={PANELS}
            layout={layout}
            localeText={LOCALE_TEXT}
            ai={ai}
            aiToolDisplay={PACT_TOOL_DISPLAY}
            onApiReady={onApiReady}
            onStateUpdated={onStateUpdated}
            onErrorRaised={onErrorRaised}
          />
        </AgStudioProvider>
      </TabsContent>
    </Tabs>
  );
}
