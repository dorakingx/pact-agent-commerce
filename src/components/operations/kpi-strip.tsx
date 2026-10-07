import { Money, Skeleton, TONE_CLASSES, cn, type StatusTone } from "@/components/ui";
import type { OpsSnapshot } from "@/lib/api/dto";
import { buildKpis, formatRate, type OpsKpi, type OpsKpiId } from "@/lib/client/ops-derive";

/** The colour of each figure's marker: amber is money on hold, emerald is money captured, violet waits on a human. */
const KPI_TONE: Record<OpsKpiId, StatusTone> = {
  deals: "neutral",
  held: "hold",
  captured: "success",
  released: "neutral",
  review: "review",
  firstPass: "info",
};

const TILE = "flex min-w-0 flex-col rounded-card border border-hairline bg-surface px-4 py-3";

function KpiValue({ kpi }: { kpi: OpsKpi }) {
  const className = "text-2xl leading-8 font-semibold tracking-[-0.02em] text-fg tabular-nums";
  if (kpi.value === null) return <span className={cn(className, "text-faint")}>—</span>;
  if (kpi.kind === "money") return <Money amountMinor={kpi.value} mutedCents className={cn(className, "font-sans")} />;
  return <span className={className}>{kpi.kind === "percent" ? formatRate(kpi.value) : kpi.value}</span>;
}

/** Headline figures of the whole ledger (not of the current filter): they come straight from `snapshot.totals`. */
export function KpiStrip({ snapshot }: { snapshot: Pick<OpsSnapshot, "totals" | "deals"> }) {
  return (
    <dl data-testid="ops-kpis" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {buildKpis(snapshot).map((kpi) => (
        <div key={kpi.id} data-testid={`ops-kpi-${kpi.id}`} className={TILE}>
          {/* Two lines are reserved at the six-across width so every figure sits on the same baseline. */}
          <dt className="flex items-start gap-2 text-[13px] leading-[1.125rem] font-medium text-muted xl:min-h-9">
            <span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", TONE_CLASSES[KPI_TONE[kpi.id]].solid)} />
            {kpi.label}
          </dt>
          <dd className="mt-1">
            <KpiValue kpi={kpi} />
            <p className="mt-0.5 text-xs leading-[1.125rem] text-pretty text-faint">{kpi.caption}</p>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function KpiStripSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className={TILE}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-7 w-20" />
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-1.5 h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}
