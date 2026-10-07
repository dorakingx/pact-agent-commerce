/**
 * /deals/{id} — the live deal. The page itself only resolves the route: the deal is read and
 * driven in the browser (it changes every few hundred milliseconds while it runs).
 */
import type { Metadata } from "next";
import { DealScreen } from "@/components/deal/deal-screen";
import { AppShell } from "@/components/shell";
import { parsePayPalReturn } from "@/lib/client/deal-derive";

export const metadata: Metadata = {
  title: "Deal",
  // Deal pages are per-session working documents, not content to index.
  robots: { index: false, follow: false },
};

export default async function DealPage({ params, searchParams }: PageProps<"/deals/[id]">) {
  const { id } = await params;
  const { paypal } = await searchParams;
  return (
    <AppShell width="full">
      {/* Keyed by id: the runner and all view state belong to exactly one deal. */}
      <DealScreen key={id} dealId={id} paypalReturn={parsePayPalReturn(paypal)} />
    </AppShell>
  );
}
