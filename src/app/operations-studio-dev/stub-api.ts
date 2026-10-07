/* TEMPORARY development stub: answers the deal API for fixture deals. Deleted before hand-off. */
import type { DealView, OpsSnapshot, ReconciliationView } from "@/lib/api/dto";
import { contractOf, deal, payment, report } from "@/lib/client/deal-derive.fixtures";

function dealViewFor(snapshot: OpsSnapshot, id: string): DealView | null {
  const row = snapshot.deals.find((candidate) => candidate.id === id);
  if (!row) return null;
  const base = deal({ status: row.status });
  const reports =
    row.verificationDecision === null
      ? []
      : row.revisionsUsed > 0
        ? [report(1, "revision_required"), report(2, row.verificationDecision)]
        : [
            row.status === "in_review"
              ? { ...report(1, "human_review"), summary: "1 condition is uncertain: the brief match could not be confirmed with enough confidence (62%).", confidence: 0.62 }
              : report(1, row.verificationDecision),
          ];
  return {
    ...base,
    id: row.id,
    code: row.code,
    statusLabel: row.statusLabel,
    seller: base.seller ? { ...base.seller, id: row.sellerId, name: row.seller, trust: row.sellerTrust, demoFault: row.sellerId === "quickdraw" ? "omits_variant" : row.sellerId === "pixelharbor" ? "embeds_instructions" : null } : null,
    contract: row.priceMinor > 0 ? contractOf(row.priceMinor) : null,
    policy:
      row.status === "awaiting_approval"
        ? {
            outcome: "needs_approval",
            spentTodayMinor: 0,
            evaluatedAt: row.createdAt,
            checks: [
              row.policyFlags.includes("seller_trust")
                ? { id: "seller_trust", label: "Seller trust", outcome: "needs_approval", detail: `${row.seller} is a new seller: the first spend needs your approval.` }
                : { id: "autonomous_limit", label: "Autonomous limit", outcome: "needs_approval", detail: `$${(row.priceMinor / 100).toFixed(2)} exceeds the $100.00 autonomous limit.` },
            ],
          }
        : base.policy,
    payment:
      row.paymentStatus === "none"
        ? null
        : payment({
            status: row.paymentStatus,
            amountMinor: row.priceMinor,
            authorizedMinor: row.authorizedMinor,
            capturedMinor: row.capturedMinor,
            orderId: row.paypalOrderId,
            authorizationId: row.paypalAuthorizationId,
            captureId: row.paypalCaptureId,
          }),
    reports,
    revisions: { used: row.revisionsUsed, limit: row.revisionLimit },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function reconciliationFor(snapshot: OpsSnapshot, id: string): ReconciliationView | null {
  const row = snapshot.deals.find((candidate) => candidate.id === id);
  if (!row) return null;
  const usd = (minor: number): string => `$${(minor / 100).toFixed(2)}`;
  return {
    dealId: id,
    status: "match",
    checkedAt: new Date().toISOString(),
    facts: [
      { field: "Order status", pact: `${row.paymentStatus} (expects COMPLETED)`, paypal: "COMPLETED", match: true },
      { field: "Order amount", pact: usd(row.priceMinor), paypal: usd(row.priceMinor), match: true },
      { field: "Contract binding (custom_id)", pact: "18a8ced61cbdb77ad6edd0bef0f05268", paypal: "18a8ced61cbdb77ad6edd0bef0f05268", match: true },
      { field: "Authorization status", pact: "captured (expects CAPTURED)", paypal: "CAPTURED", match: true },
      { field: "Authorized amount", pact: usd(row.authorizedMinor), paypal: usd(row.authorizedMinor), match: true },
      { field: "Captured amount", pact: usd(row.capturedMinor), paypal: usd(row.capturedMinor), match: true },
    ],
    narrative: null,
    toolCalls: [],
    source: "deterministic",
    model: null,
    note: "Simulated payments: the comparison is against the payment simulator's own record.",
  };
}

/** Patch `fetch` so fixture deal ids resolve. Idempotent. */
export function installStubApi(getSnapshot: () => OpsSnapshot): void {
  const marker = window as unknown as { __pactStub?: boolean };
  if (marker.__pactStub) return;
  marker.__pactStub = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = /\/api\/deals\/(deal_[a-z0-9]+)(\/reconcile)?$/.exec(url.split("?")[0] ?? "");
    if (!match) return original(input, init);
    const body = match[2] ? reconciliationFor(getSnapshot(), match[1]!) : (() => {
      const view = dealViewFor(getSnapshot(), match[1]!);
      return view === null ? null : { deal: view };
    })();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return body === null
      ? Response.json({ error: { code: "not_found", message: "Deal not found", requestId: "stub" } }, { status: 404 })
      : Response.json(body, { headers: { "x-request-id": "stub" } });
  };
}
