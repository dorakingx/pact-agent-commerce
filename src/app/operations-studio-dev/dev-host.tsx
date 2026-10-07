"use client";

/* TEMPORARY development host for the AG Studio dashboard. Deleted before hand-off. */
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import useSWR from "swr";
import type { OpsSnapshot } from "@/lib/api/dto";
import { fetcher } from "@/lib/client/api";
import { fixtureSnapshot } from "./fixture";
import { installStubApi } from "./stub-api";

const FIXTURE_NOW = Date.UTC(2026, 9, 6, 9, 0, 0);

const StudioDashboard = dynamic(() => import("@/components/operations/studio"), {
  ssr: false,
  loading: () => <div className="h-[640px] animate-shimmer rounded-card border border-hairline bg-surface" />,
});

export function DevHost() {
  const fixture = useSearchParams().has("fixture");
  const { data } = useSWR<OpsSnapshot>(fixture ? null : "/api/operations", fetcher, { refreshInterval: 15_000 });
  const [opened, setOpened] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const snapshot = useMemo(() => (fixture ? fixtureSnapshot(FIXTURE_NOW + tick * 3_600_000) : data), [fixture, data, tick]);
  // Installed before the dashboard mounts, so its first requests are already answered.
  useState(() => (fixture && typeof window !== "undefined" ? installStubApi(() => fixtureSnapshot(FIXTURE_NOW)) : undefined));
  if (!snapshot) return <div className="h-[640px] animate-shimmer rounded-card border border-hairline bg-surface" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-muted">
        <span data-testid="dev-opened">opened: {opened ?? "—"}</span>
        <button type="button" data-testid="dev-tick" className="rounded-control border border-hairline px-2 py-1" onClick={() => setTick((n) => n + 1)}>
          simulate refresh
        </button>
      </div>
      <StudioDashboard snapshot={snapshot} onOpenDeal={setOpened} />
    </div>
  );
}
