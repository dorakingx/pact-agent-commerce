"use client";

/**
 * Frame of the Operations page: heading with the refresh controls, the KPI strip, and the two
 * views of the same snapshot — the AG Studio dashboard and the AG Grid ledger — plus the deal
 * inspector either view can open.
 */
import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowRight, Inbox, LayoutDashboard, RefreshCw, Table2 } from "lucide-react";
import { PageHeader } from "@/components/shell";
import { Button, EmptyState, LinkButton, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "@/components/ui";
import { DEFAULT_OPS_VIEW, OPS_VIEWS, parseOpsView, type OpsView } from "@/lib/client/ops-derive";
import { OPS_REFRESH_MS, useOps } from "@/lib/client/use-ops";
import { DealInspector } from "./deal-inspector";
import { KpiStrip } from "./kpi-strip";
import { OPERATIONS_DESCRIPTION, OPERATIONS_TITLE, OperationsDataSkeleton } from "./operations-skeleton";
import { OpsRequestError } from "./request-error";
import { StudioPanel } from "./studio-panel";

function LedgerSkeleton() {
  return (
    <div data-testid="ledger-loading" role="status" aria-label="Loading the ledger" className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-28 rounded-full" />
        ))}
      </div>
      <Skeleton className="h-8 w-full max-w-xl" />
      <Skeleton className="h-[26rem] w-full rounded-card" />
    </div>
  );
}

// AG Grid and AG Charts only run in the browser, and only the Ledger tab needs them.
const Ledger = dynamic(() => import("./ledger/ledger"), { ssr: false, loading: () => <LedgerSkeleton /> });

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown" : CLOCK.format(date);
}

const VIEW_LABEL: Record<OpsView, string> = { dashboard: "Dashboard", ledger: "Ledger" };
const VIEW_PARAM = "view";
const DEAL_PARAM = "deal";

export function OperationsView() {
  const { snapshot, error, isLoading, isRefreshing, refresh } = useOps();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = parseOpsView(searchParams.get(VIEW_PARAM));
  // The inspected deal lives in the URL too, so a drill-down can be linked to and reloaded.
  const inspectedId = searchParams.get(DEAL_PARAM);
  // The element that had focus when the inspector was opened (a grid cell, a dashboard widget).
  const openerRef = useRef<HTMLElement | null>(null);

  // A tab is mounted on its first visit and then kept (hidden) so that switching views does not
  // throw away the ledger's filters or the dashboard's layout edits.
  const [visited, setVisited] = useState<ReadonlySet<OpsView>>(() => new Set([view]));
  if (!visited.has(view)) setVisited(new Set(visited).add(view));

  /**
   * Rewrites the query string in place. The router picks the change up (useSearchParams
   * re-renders) without a round trip to the server and without adding a history entry.
   */
  const updateQuery = useCallback(
    (change: (params: URLSearchParams) => void) => {
      // Read from the address bar, not from the last render: two updates in one tick must not undo each other.
      const params = new URLSearchParams(window.location.search);
      change(params);
      const query = params.toString();
      window.history.replaceState(null, "", query.length > 0 ? `${pathname}?${query}` : pathname);
    },
    [pathname],
  );

  const changeView = useCallback(
    (next: string) => {
      const target = parseOpsView(next);
      updateQuery((params) => {
        if (target === DEFAULT_OPS_VIEW) params.delete(VIEW_PARAM);
        else params.set(VIEW_PARAM, target);
      });
    },
    [updateQuery],
  );
  const openLedger = useCallback(() => changeView("ledger"), [changeView]);
  const openInspector = useCallback(
    (dealId: string) => {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      updateQuery((params) => params.set(DEAL_PARAM, dealId));
    },
    [updateQuery],
  );
  const closeInspector = useCallback(() => updateQuery((params) => params.delete(DEAL_PARAM)), [updateQuery]);
  const inspectorOpener = useCallback(() => openerRef.current, []);

  const inspectedRow = useMemo(
    () => (inspectedId === null ? null : (snapshot?.deals.find((deal) => deal.id === inspectedId) ?? null)),
    [inspectedId, snapshot],
  );

  const header = (
    <PageHeader
      title={OPERATIONS_TITLE}
      description={OPERATIONS_DESCRIPTION}
      actions={
        <>
          {snapshot ? (
            <p data-testid="ops-updated" className="text-[13px] leading-5 text-muted tabular-nums">
              Updated {clockTime(snapshot.generatedAt)}
              <span className="text-faint max-sm:hidden"> · refreshes every {Math.round(OPS_REFRESH_MS / 1000)} s</span>
            </p>
          ) : null}
          {/* Stays enabled while a request is in flight (requests are de-duplicated), so it never drops keyboard focus. */}
          <Button variant="secondary" size="sm" onClick={refresh} aria-busy={isRefreshing || undefined} data-testid="ops-refresh">
            <RefreshCw aria-hidden="true" className={cn(isRefreshing && "animate-spin")} />
            Refresh
          </Button>
        </>
      }
    />
  );

  if (!snapshot) {
    return (
      <>
        {header}
        {error && !isLoading ? (
          <OpsRequestError testId="ops-error" title="The operations data could not be loaded" error={error} onRetry={refresh} />
        ) : (
          <OperationsDataSkeleton />
        )}
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        {error ? (
          <OpsRequestError
            testId="ops-stale"
            tone="warning"
            title={`Could not refresh. Showing the ledger as of ${clockTime(snapshot.generatedAt)}.`}
            error={error}
            onRetry={refresh}
          />
        ) : null}

        <KpiStrip snapshot={snapshot} />

        {snapshot.deals.length === 0 ? (
          <div data-testid="ops-empty" className="rounded-card border border-dashed border-hairline-strong bg-surface">
            <EmptyState
              as="h2"
              icon={<Inbox />}
              title="No deals yet"
              description="Give your buyer agent a task in the Workspace. Each deal appears here the moment it starts, with its contract, its PayPal authorization and every verification result. Showcase deals are listed too once the operator has seeded them."
              action={
                <LinkButton href="/workspace" data-testid="ops-empty-workspace">
                  Start a deal in the Workspace
                  <ArrowRight aria-hidden="true" />
                </LinkButton>
              }
            />
          </div>
        ) : (
          <Tabs value={view} onValueChange={changeView}>
            <TabsList aria-label="Operations views">
              {OPS_VIEWS.map((id) => (
                <TabsTrigger key={id} value={id} data-testid={`ops-tab-${id}`}>
                  {id === "dashboard" ? <LayoutDashboard aria-hidden="true" /> : <Table2 aria-hidden="true" />}
                  {VIEW_LABEL[id]}
                  {id === "ledger" ? (
                    <span className="font-mono text-xs font-normal text-faint tabular-nums">{snapshot.deals.length}</span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="dashboard" forceMount hidden={view !== "dashboard"} data-testid="ops-panel-dashboard">
              {visited.has("dashboard") ? <StudioPanel snapshot={snapshot} onOpenDeal={openInspector} onOpenLedger={openLedger} /> : null}
            </TabsContent>
            <TabsContent value="ledger" forceMount hidden={view !== "ledger"} data-testid="ops-panel-ledger">
              {visited.has("ledger") ? <Ledger snapshot={snapshot} onOpenDeal={openInspector} /> : null}
            </TabsContent>
          </Tabs>
        )}
      </div>
      <DealInspector row={inspectedRow} onClose={closeInspector} returnFocusTo={inspectorOpener} />
    </>
  );
}
