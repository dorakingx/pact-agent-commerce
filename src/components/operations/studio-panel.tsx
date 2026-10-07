"use client";

/**
 * The Dashboard tab: the AG Studio dashboard, loaded on demand. Studio pulls in the enterprise
 * grid and charts bundles, so it is kept out of the page's first load and out of the Ledger's
 * way: if it fails to load or throws while rendering, the operator is pointed at the Ledger,
 * which runs on the Community packages and does not depend on it.
 */
import dynamic from "next/dynamic";
import { Component, type ReactNode } from "react";
import { LayoutDashboard, Table2 } from "lucide-react";
import { Button, EmptyState, Skeleton } from "@/components/ui";
import type { OpsSnapshot } from "@/lib/api/dto";

function StudioSkeleton() {
  return (
    <div
      data-testid="studio-loading"
      role="status"
      aria-label="Loading the dashboard"
      className="grid min-h-[32rem] grid-cols-6 grid-rows-[5.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-3 rounded-card border border-hairline bg-surface p-3"
    >
      <Skeleton className="col-span-2 h-full" />
      <Skeleton className="col-span-2 h-full" />
      <Skeleton className="col-span-2 h-full" />
      <Skeleton className="col-span-3 h-full" />
      <Skeleton className="col-span-3 h-full" />
      <Skeleton className="col-span-6 h-full" />
    </div>
  );
}

const StudioDashboard = dynamic(() => import("@/components/operations/studio"), {
  ssr: false,
  loading: () => <StudioSkeleton />,
});

interface StudioBoundaryProps {
  onOpenLedger: () => void;
  children: ReactNode;
}

class StudioBoundary extends Component<StudioBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div data-testid="studio-error" className="rounded-card border border-hairline bg-surface">
        <EmptyState
          as="h2"
          icon={<LayoutDashboard />}
          title="The dashboard could not load"
          description="The Ledger shows the same deals with sorting, filters, charts and CSV export, and does not depend on the dashboard."
          action={
            <>
              <Button onClick={this.props.onOpenLedger} data-testid="studio-error-open-ledger">
                <Table2 aria-hidden="true" />
                Open the Ledger
              </Button>
              {/* A failed chunk stays failed for this page view, so the retry is a reload. */}
              <Button variant="secondary" onClick={() => window.location.reload()}>
                Reload the page
              </Button>
            </>
          }
        />
      </div>
    );
  }
}

export interface StudioPanelProps {
  snapshot: OpsSnapshot;
  onOpenDeal: (dealId: string) => void;
  onOpenLedger: () => void;
}

export function StudioPanel({ snapshot, onOpenDeal, onOpenLedger }: StudioPanelProps) {
  return (
    <StudioBoundary onOpenLedger={onOpenLedger}>
      <StudioDashboard snapshot={snapshot} onOpenDeal={onOpenDeal} />
    </StudioBoundary>
  );
}
