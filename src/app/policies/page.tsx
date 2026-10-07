import type { Metadata } from "next";
import { PoliciesScreen } from "@/components/policies";
import { AppShell, PageHeader } from "@/components/shell";

export const metadata: Metadata = {
  title: "Policies",
  description:
    "Spending controls for the buyer agent and the delegated PayPal wallet. Limits are evaluated in code before any PayPal call.",
};

/**
 * /policies — what the buyer agent may commit without a human, and how it is allowed to pay.
 * The shell and heading are static; the form and wallet read the session's data in the browser.
 */
export default function PoliciesPage() {
  return (
    <AppShell>
      <PageHeader
        title="Policies"
        description="What your buyer agent may commit without you, and how it is allowed to pay. Every limit here is evaluated in code before any PayPal call. No model can raise one."
      />
      <PoliciesScreen />
    </AppShell>
  );
}
