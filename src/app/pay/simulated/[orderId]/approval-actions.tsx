"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, LinkButton, useHydrated } from "@/components/ui";
import { ApiClientError, api } from "@/lib/client/api";
// Type-only: the service module itself is server-side and never reaches the browser bundle.
import type { ApprovalOutcome, PayPalReturnResult } from "@/lib/services/deals";

export interface ApprovalActionsProps {
  orderId: string;
  /** The deal this order belongs to, when PACT knows it. */
  dealId: string | null;
  /** False once the order has been approved, authorized or cancelled. */
  awaitingPayer: boolean;
}

type Action = "approve" | "cancel";

/** What the deal page is told after an approval attempt, mirroring the real PayPal return. */
const RESULT_OF_APPROVAL: Record<ApprovalOutcome, PayPalReturnResult> = {
  authorized: "approved",
  pending: "pending",
  failed: "error",
};

function describe(error: unknown): string {
  if (!(error instanceof ApiClientError)) return "Something went wrong. Please try again.";
  return error.requestId ? `${error.message} (request ${error.requestId})` : error.message;
}

/**
 * The two things a payer can do on PayPal's approval page: approve, or back out. Both go
 * through the server, which only accepts them from the session that owns the deal.
 */
export function ApprovalActions({ orderId, dealId, awaitingPayer }: ApprovalActionsProps) {
  const router = useRouter();
  const [running, setRunning] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Server-rendered: until hydration a click would be silently lost.
  const hydrated = useHydrated();

  async function approve(): Promise<PayPalReturnResult> {
    const { outcome } = await api.post<{ dealId: string; outcome: ApprovalOutcome }>("/api/simulated/approve", { orderId });
    return RESULT_OF_APPROVAL[outcome];
  }

  async function cancel(): Promise<PayPalReturnResult> {
    await api.post<{ dealId: string; outcome: "cancelled" }>("/api/simulated/cancel", { orderId });
    return "cancelled";
  }

  async function run(action: Action): Promise<void> {
    setRunning(action);
    setError(null);
    try {
      const result = await (action === "approve" ? approve() : cancel());
      // The button stays busy until the deal page takes over.
      router.push(dealId === null ? "/workspace" : `/deals/${dealId}?paypal=${result}`);
    } catch (cause) {
      setError(describe(cause));
      setRunning(null);
    }
  }

  if (!awaitingPayer) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">This simulated order has already been approved or cancelled. There is nothing left to do here.</p>
        {dealId === null ? null : (
          <LinkButton href={`/deals/${dealId}`} variant="secondary">
            Back to the deal
          </LinkButton>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error === null ? null : <Callout tone="danger">{error}</Callout>}
      <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => void run("cancel")} loading={running === "cancel"} disabled={running !== null || !hydrated}>
          Cancel
        </Button>
        <Button onClick={() => void run("approve")} loading={running === "approve"} disabled={running !== null || !hydrated}>
          Approve simulated hold
        </Button>
      </div>
    </div>
  );
}
