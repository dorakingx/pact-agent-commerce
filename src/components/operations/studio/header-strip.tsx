"use client";

import { Download, LayoutDashboard, Plus, Redo2, RotateCcw, Sparkles, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { RelativeTime } from "@/components/ui/relative-time";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { isBuiltInPage, pageLabel } from "@/lib/client/studio-pages";

export interface HeaderStripProps {
  /** Page ids in order. The strip must sit inside the `Tabs` root whose value is the selected page. */
  pages: readonly string[];
  selectedPageId: string;
  onAddPage: () => void;
  onRemovePage: (pageId: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onExport: () => void;
  /** False until Studio's API exists: the controls that drive it wait for it. */
  ready: boolean;
  /** When the data on screen was produced. */
  generatedAt: string;
  /** True when no AG Studio licence key is configured. */
  trial: boolean;
  agents:
    | { state: "available"; open: boolean; onToggle: () => void; activity: string | null; running: boolean }
    | { state: "unavailable"; message: string };
}

/**
 * The strip above the dashboard. AG Studio draws the canvas, the panels and the widgets; it
 * draws nothing for a report's pages, its history or its saved state, so those controls live
 * here, next to one sentence saying what the visitor is looking at.
 */
export function HeaderStrip(props: HeaderStripProps) {
  const { pages, selectedPageId, agents, ready } = props;
  const removable = pages.length > 1 && !isBuiltInPage(selectedPageId);
  return (
    <div data-testid="studio-header" className="rounded-card border border-hairline bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline px-3.5 py-2.5">
        <LayoutDashboard aria-hidden="true" className="size-4 shrink-0 text-accent" />
        <p className="min-w-0 flex-1 basis-80 text-[13px] leading-5 text-muted">
          <span className="font-semibold text-fg">A live AG Studio report over PACT&rsquo;s ledger.</span> Drag, resize and add widgets or pages,
          filter by clicking, or ask the agents. Everything here is read-only: nothing on this page can move money.
        </p>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {props.trial ? (
            <Tooltip content="No AG Studio licence key is configured, so Studio runs in its trial mode: AG's watermark and console notice are expected.">
              <Badge tone="neutral" variant="outline" tabIndex={0} data-testid="studio-trial-note" className="focus-ring">
                AG Studio trial mode
              </Badge>
            </Tooltip>
          ) : null}
          <span data-testid="studio-data-age">
            Data updated <RelativeTime value={props.generatedAt} />
          </span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-2.5 py-2">
        <TabsList variant="segmented" aria-label="Report pages" data-testid="studio-pages">
          {pages.map((id) => (
            <TabsTrigger key={id} value={id} data-testid={`studio-page-${id}`}>
              {pageLabel(id)}
            </TabsTrigger>
          ))}
        </TabsList>
        <Tooltip content="Add an empty page">
          <Button variant="ghost" size="sm" iconOnly aria-label="Add a page" data-testid="studio-add-page" disabled={!ready} onClick={props.onAddPage}>
            <Plus aria-hidden="true" />
          </Button>
        </Tooltip>
        {removable ? (
          <Tooltip content={`Remove ${pageLabel(selectedPageId)}`}>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Remove ${pageLabel(selectedPageId)}`}
              data-testid="studio-remove-page"
              disabled={!ready}
              onClick={() => props.onRemovePage(selectedPageId)}
            >
              <X aria-hidden="true" />
            </Button>
          </Tooltip>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-1">
          {agents.state === "available" ? (
            <span
              data-testid="studio-agent-activity"
              aria-live="polite"
              className={cn("mr-1 hidden items-center gap-1.5 text-xs text-muted xl:inline-flex", !agents.running && agents.activity === null && "xl:hidden")}
            >
              {agents.running ? (
                <>
                  <Spinner label={null} className="size-3.5" />
                  Agents working…
                </>
              ) : (
                agents.activity
              )}
            </span>
          ) : null}
          <Tooltip content="Undo (Ctrl/⌘ Z)">
            <Button variant="ghost" size="sm" iconOnly aria-label="Undo" data-testid="studio-undo" disabled={!ready || !props.canUndo} onClick={props.onUndo}>
              <Undo2 aria-hidden="true" />
            </Button>
          </Tooltip>
          <Tooltip content="Redo (Ctrl/⌘ Shift Z)">
            <Button variant="ghost" size="sm" iconOnly aria-label="Redo" data-testid="studio-redo" disabled={!ready || !props.canRedo} onClick={props.onRedo}>
              <Redo2 aria-hidden="true" />
            </Button>
          </Tooltip>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <Button variant="ghost" size="sm" data-testid="studio-reset" disabled={!ready} onClick={props.onReset}>
            <RotateCcw aria-hidden="true" />
            Reset to PACT default
          </Button>
          <Tooltip content="Download this report's layout as JSON (AG Studio state). Each chart and table also has its own CSV and image export in its toolbar.">
            <Button variant="ghost" size="sm" data-testid="studio-export" disabled={!ready} onClick={props.onExport}>
              <Download aria-hidden="true" />
              Export
            </Button>
          </Tooltip>
          <Separator orientation="vertical" className="mx-1 h-5" />
          {agents.state === "available" ? (
            <Button
              variant={agents.open ? "secondary" : "primary"}
              size="sm"
              data-testid="studio-agents-toggle"
              aria-pressed={agents.open}
              disabled={!ready}
              onClick={agents.onToggle}
            >
              <Sparkles aria-hidden="true" />
              {agents.open ? "Hide agents" : "Ask the agents"}
            </Button>
          ) : (
            <Tooltip content={agents.message}>
              <Button variant="secondary" size="sm" data-testid="studio-agents-toggle" aria-disabled="true" aria-describedby="studio-agents-off">
                <Sparkles aria-hidden="true" />
                Agents off
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      {agents.state === "unavailable" ? (
        <p id="studio-agents-off" data-testid="studio-agents-off" className="border-t border-hairline px-3.5 py-2 text-xs leading-[18px] text-muted">
          {agents.message} The dashboard, its filters and its editor work without them.
        </p>
      ) : null}
    </div>
  );
}
