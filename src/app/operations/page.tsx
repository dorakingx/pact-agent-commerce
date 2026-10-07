import type { Metadata } from "next";
import { Suspense } from "react";
import { OperationsFallback } from "@/components/operations/operations-skeleton";
import { OperationsView } from "@/components/operations/operations-view";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Operations",
  description:
    "Supervise agent spend: every deal with its contract, PayPal authorization, verification evidence and settlement, in a filterable ledger and a dashboard.",
};

/**
 * /operations — the operator's view of every deal the session can see (its own and the
 * showcase). The page itself is static; the live view reads `?view=` and the snapshot in the
 * browser, so the server sends the heading with a skeleton and the client takes over.
 */
export default function OperationsPage() {
  return (
    <AppShell>
      <Suspense fallback={<OperationsFallback />}>
        <OperationsView />
      </Suspense>
    </AppShell>
  );
}
