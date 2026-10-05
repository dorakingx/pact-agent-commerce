/**
 * /pay/simulated/{orderId} — stands in for PayPal's approval page when no PayPal credentials
 * are configured (keyless local development, CI). With real PayPal active this page does not
 * exist (404), and nothing on it could be mistaken for a real payment: it says "simulated"
 * before it says anything else.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell";
import { Callout, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, KeyValue, KeyValueList, Money, MonoId } from "@/components/ui";
import { getServiceContext } from "@/lib/services/context";
import { getSimulatedCheckout } from "@/lib/services/deals";
import { ApprovalActions } from "./approval-actions";

export const metadata: Metadata = {
  title: "Simulated PayPal approval",
  robots: { index: false, follow: false },
};

/** The order's state is read from the database on every request; a cached copy could show a settled order as open. */
export const dynamic = "force-dynamic";

export default async function SimulatedApprovalPage({ params }: PageProps<"/pay/simulated/[orderId]">) {
  const { orderId } = await params;
  const checkout = await getSimulatedCheckout(await getServiceContext(), orderId);
  if (checkout === null) notFound();

  return (
    <AppShell className="flex justify-center">
      <div className="flex w-full max-w-lg flex-col gap-5">
        <h1 className="text-2xl leading-8 font-semibold tracking-[-0.02em] text-fg">Simulated PayPal approval</h1>
        <Callout tone="warning" title="Simulated PayPal approval — no PayPal credentials are configured, so no real sandbox payment exists for this deal">
          This page stands in for PayPal&apos;s approval screen. No money, real or sandbox, is involved.
        </Callout>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Authorization hold requested</CardTitle>
            <CardDescription>
              Approving places a simulated hold for the contract price. The amount is held, not captured: PACT captures it
              only after the delivery has been verified against the contract, and releases it otherwise.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="pb-3 text-fg">
              <Money amountMinor={checkout.amountMinor} mutedCents className="text-3xl font-semibold" />
              <span className="ml-2 text-sm text-muted">USD · simulated</span>
            </p>
            <KeyValueList divided>
              <KeyValue label="For">{checkout.description}</KeyValue>
              <KeyValue label="Simulated order">
                <MonoId value={checkout.orderId} label="simulated order id" head={10} tail={6} />
              </KeyValue>
            </KeyValueList>
          </CardContent>
          <CardFooter className="flex-col items-stretch">
            <ApprovalActions orderId={checkout.orderId} dealId={checkout.dealId} awaitingPayer={checkout.awaitingPayer} />
          </CardFooter>
        </Card>
      </div>
    </AppShell>
  );
}
