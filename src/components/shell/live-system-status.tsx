"use client";

import Link from "next/link";
import { Activity, ArrowRight, ChevronDown, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusPill } from "@/components/ui/status-pill";
import { TONE_CLASSES, type StatusTone } from "@/components/ui/tone";
import type { ApiClientError } from "@/lib/client/api";
import {
  SYSTEM_STATUS_GROUP_LABEL,
  describeSystemStatus,
  useSystemStatus,
  type SystemStatusGroup,
  type SystemStatusRow,
  type SystemStatusView,
} from "@/lib/client/use-system-status";
import { SystemStatusPill } from "./system-status-pill";

export interface LiveSystemStatusProps {
  /**
   * Below the `lg` breakpoint, shrink the trigger to an icon with a status dot. The header uses
   * this between 768 and 1024px, where the navigation leaves no room for the full pill.
   */
  compactBelowLg?: boolean;
  /**
   * Stem of the `data-testid`s (`<stem>-trigger`, `<stem>-panel`). The header and the navigation
   * drawer each mount one, so the drawer passes its own to keep selectors unambiguous.
   */
  testId?: string;
  className?: string;
}

const GROUPS: readonly SystemStatusGroup[] = ["payments", "agents", "platform"];

const PROVIDER_TONE: Record<SystemStatusView["provider"], StatusTone> = {
  paypal_sandbox: "success",
  simulated: "hold",
};

function StatusRow({ row }: { row: SystemStatusRow }) {
  return (
    // dt, value and explanation are direct children of one group, as <dl> requires.
    <div data-testid={`system-status-row-${row.id}`} data-tone={row.tone} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 py-1.5">
      <dt className="text-[13px] leading-5 text-muted">{row.label}</dt>
      <dd className={cn("flex min-w-0 items-center justify-end gap-1.5 text-right text-[13px] leading-5 font-medium text-fg", row.mono && "font-mono text-xs")}>
        {row.tone === "neutral" ? null : (
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", TONE_CLASSES[row.tone].solid)} />
        )}
        <span className="min-w-0 break-words">{row.value}</span>
      </dd>
      {row.detail ? <dd className="col-span-2 mt-0.5 text-xs leading-[18px] text-pretty text-muted">{row.detail}</dd> : null}
    </div>
  );
}

function StatusDetails({ view }: { view: SystemStatusView }) {
  return (
    <div className="flex flex-col gap-3">
      {view.problems.length > 0 ? (
        <div role="alert" className="flex gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3 py-2.5 text-[13px] leading-5 text-fg">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <div>
            <p className="font-semibold">Degraded</p>
            <ul className="mt-0.5 flex flex-col gap-1 text-fg/85">
              {view.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {GROUPS.map((group) => {
        const rows = view.rows.filter((row) => row.group === group);
        if (rows.length === 0) return null;
        return (
          <section key={group} aria-label={SYSTEM_STATUS_GROUP_LABEL[group]}>
            <p aria-hidden="true" className="font-mono text-[10px] leading-4 font-medium tracking-[0.08em] text-faint uppercase">
              {SYSTEM_STATUS_GROUP_LABEL[group]}
            </p>
            <dl className="mt-0.5">
              {rows.map((row) => (
                <StatusRow key={row.id} row={row} />
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

function LoadError({ error, stale, onRetry }: { error: ApiClientError; stale: boolean; onRetry: () => void }) {
  return (
    <div role="alert" data-testid="system-status-error" className="rounded-control border border-danger/25 bg-danger-soft px-3 py-2.5 text-[13px] leading-5 text-fg">
      <p className="font-semibold">{stale ? "Could not refresh the status" : "The system status could not be loaded"}</p>
      <p className="mt-0.5 text-fg/85">
        {error.message}
        {stale ? " Showing the last report received." : null}
      </p>
      {error.requestId ? <p className="mt-1 font-mono text-[11px] text-muted">Request {error.requestId}</p> : null}
      <Button variant="secondary" size="sm" className="mt-2.5" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * The header's statement of what is real in this deployment, read from GET /api/health and
 * refreshed every minute. The pill is the summary; the popover says why (which payment rail
 * and why, whether webhooks are verified, which models the agents run on).
 */
export function LiveSystemStatus({ compactBelowLg = false, testId = "system-status", className }: LiveSystemStatusProps) {
  const { status, error, isRefreshing, reload } = useSystemStatus();
  const view = status === undefined ? null : describeSystemStatus(status);
  const degraded = view !== null && view.problems.length > 0;
  const unavailable = view === null && error !== undefined;

  const tone: StatusTone = degraded || unavailable ? "danger" : view === null ? "neutral" : PROVIDER_TONE[view.provider];
  const summary = unavailable
    ? "System status unavailable"
    : degraded
      ? "System degraded"
      : view === null
        ? "Checking the system status"
        : `Payments: ${view.rows.find((row) => row.id === "payment-rail")?.value ?? "unknown"}`;
  const pill = unavailable ? (
    <StatusPill tone="danger" size="sm" icon={<TriangleAlert aria-hidden="true" />}>
      Status unavailable
    </StatusPill>
  ) : degraded ? (
    <StatusPill tone="danger" size="sm" icon={<TriangleAlert aria-hidden="true" />}>
      Degraded · {(status?.degraded ?? []).join(", ")}
    </StatusPill>
  ) : (
    <SystemStatusPill provider={view?.provider ?? "unknown"} ai={view?.ai ?? "unknown"} />
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`${testId}-trigger`}
          data-state-tone={tone}
          className={cn(
            "group inline-flex items-center rounded-full transition-opacity duration-150 ease-out focus-ring hover:opacity-85 pointer-coarse:min-h-11",
            className,
          )}
        >
          <span className={cn("inline-flex items-center gap-1", compactBelowLg && "max-lg:hidden")}>
            {pill}
            {/* Says "this opens", which a pill on its own does not. */}
            <ChevronDown aria-hidden="true" className="size-3.5 text-faint transition-transform duration-150 ease-out group-data-[state=open]:rotate-180" />
          </span>
          {compactBelowLg ? (
            <span className="relative flex size-8 items-center justify-center rounded-control text-muted group-hover:bg-subtle-strong/70 lg:hidden">
              <Activity aria-hidden="true" className="size-4" />
              <span aria-hidden="true" className={cn("absolute top-1.5 right-1.5 size-2 rounded-full ring-2 ring-canvas", TONE_CLASSES[tone].solid)} />
              {/* The pill and its wording are not rendered at this width, so the summary is spoken instead. */}
              <span className="sr-only">{summary}.</span>
            </span>
          ) : null}
          <span className="sr-only">Show system status details</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="System status" data-testid={`${testId}-panel`} className="w-[22rem] p-0">
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-4 py-3">
          <div>
            <p className="text-sm leading-5 font-semibold text-fg">System status</p>
            <p className="text-xs leading-[18px] text-muted">What is real in this deployment, read from the server.</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Refresh system status"
            data-testid="system-status-refresh"
            onClick={reload}
            className="-mt-0.5 -mr-1.5"
          >
            <RefreshCw aria-hidden="true" className={cn(isRefreshing && "animate-spin")} />
          </Button>
        </div>
        <div className="flex max-h-[min(28rem,calc(100dvh-9rem))] flex-col gap-3 overflow-y-auto px-4 py-3" aria-live="polite">
          {error ? <LoadError error={error} stale={view !== null} onRetry={reload} /> : null}
          {view ? (
            <StatusDetails view={view} />
          ) : error ? null : (
            <p className="py-4 text-center text-[13px] text-muted">Checking the deployment…</p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-hairline px-4 py-2.5 text-xs leading-5 text-muted">
          <span>Sandbox demo. No real money moves.</span>
          <PopoverClose asChild>
            <Link
              href="/how-it-works"
              className="inline-flex shrink-0 items-center gap-1 rounded-sm font-medium text-fg underline-offset-4 focus-ring hover:underline"
            >
              How it works
              <ArrowRight aria-hidden="true" className="size-3" />
            </Link>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}
