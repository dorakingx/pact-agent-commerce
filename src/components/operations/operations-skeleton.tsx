import { PageHeader } from "@/components/shell";
import { Skeleton } from "@/components/ui";
import { KpiStripSkeleton } from "./kpi-strip";

export const OPERATIONS_TITLE = "Operations";
export const OPERATIONS_DESCRIPTION =
  "What your agents committed, what PayPal is holding, and what was captured or released.";

/** Placeholder for the KPI strip and the tab area while the first snapshot loads. */
export function OperationsDataSkeleton() {
  return (
    <div data-testid="ops-loading" role="status" aria-label="Loading operations data" className="flex flex-col gap-6">
      <KpiStripSkeleton />
      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="flex gap-5 border-b border-hairline pb-3">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="h-[26rem] w-full rounded-card" />
      </div>
    </div>
  );
}

/**
 * What the server sends for /operations: the real heading and a skeleton. The live view reads
 * `?view=` in the browser, so everything below the heading is rendered there.
 */
export function OperationsFallback() {
  return (
    <>
      <PageHeader title={OPERATIONS_TITLE} description={OPERATIONS_DESCRIPTION} />
      <OperationsDataSkeleton />
    </>
  );
}
