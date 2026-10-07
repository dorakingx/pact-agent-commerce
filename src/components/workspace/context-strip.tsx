"use client";

import Link from "next/link";
import useSWR from "swr";
import { ArrowRight, CreditCard, ShieldCheck, Wallet } from "lucide-react";
import { Button, Money, Skeleton, cn } from "@/components/ui";
import type { PolicyResponse, WalletStatus } from "@/lib/api/dto";
import { ApiClientError, fetcher } from "@/lib/client/api";

/*
 * The three facts that decide how the next deal will be paid for: how much the agent may commit
 * alone, whether it has a pre-consented wallet, and whether PayPal is real or simulated here.
 * The keys are the ones the Policies screen reads, so both screens share one cache entry.
 */
const POLICY_PATH = "/api/policy";
const WALLET_PATH = "/api/wallet";

function Item({
  testId,
  icon,
  label,
  children,
  value,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  value?: string;
}) {
  return (
    <div data-testid={testId} data-value={value} className="flex min-w-0 items-center justify-between gap-3 px-3.5 py-2 sm:flex-col sm:items-start sm:justify-center sm:gap-0.5">
      <dt className="flex items-center gap-1.5 text-xs leading-5 text-muted [&_svg]:size-3.5 [&_svg]:shrink-0">
        {icon}
        {label}
      </dt>
      <dd className="text-[13px] leading-5 font-semibold whitespace-nowrap text-fg">{children}</dd>
    </div>
  );
}

function Pending() {
  return <Skeleton className="h-4 w-20" />;
}

export function ContextStrip({ className }: { className?: string }) {
  const policy = useSWR<PolicyResponse, ApiClientError>(POLICY_PATH, fetcher, { revalidateOnFocus: false });
  const wallet = useSWR<WalletStatus, ApiClientError>(WALLET_PATH, fetcher, { revalidateOnFocus: false });
  const failure = (policy.data === undefined ? policy.error : undefined) ?? (wallet.data === undefined ? wallet.error : undefined);

  if (failure) {
    return (
      <div role="alert" data-testid="context-strip-error" className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-danger/25 bg-danger-soft px-3.5 py-2 text-[13px] leading-5 text-fg", className)}>
        <span>
          Limits and wallet status could not be loaded.
          {failure.requestId ? <span className="ml-1 font-mono text-xs text-muted">Request {failure.requestId}</span> : null}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void policy.mutate();
            void wallet.mutate();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  const delegated = wallet.data?.effectiveMode === "delegated";
  const simulated = wallet.data?.provider === "simulated";

  return (
    <div className={cn("flex flex-col items-stretch gap-1.5 sm:items-end", className)}>
      <dl data-testid="context-strip" className="flex flex-col divide-y divide-hairline rounded-card border border-hairline bg-surface sm:flex-row sm:divide-x sm:divide-y-0">
        <Item
          testId="context-autonomous-limit"
          icon={<ShieldCheck aria-hidden="true" />}
          label="Autonomous limit"
          value={policy.data ? String(policy.data.policy.autonomousLimitMinor) : undefined}
        >
          {policy.data ? <Money amountMinor={policy.data.policy.autonomousLimitMinor} /> : <Pending />}
        </Item>
        <Item
          testId="context-wallet"
          icon={<Wallet aria-hidden="true" />}
          label="Payment approval"
          value={wallet.data?.effectiveMode}
        >
          {wallet.data ? delegated ? "Agent wallet connected" : "Interactive approval" : <Pending />}
        </Item>
        <Item testId="context-provider" icon={<CreditCard aria-hidden="true" />} label="Payment rail" value={wallet.data?.provider}>
          {wallet.data ? (
            <span className={cn(simulated && "text-hold")}>{simulated ? "Simulated" : "PayPal Sandbox"}</span>
          ) : (
            <Pending />
          )}
        </Item>
      </dl>
      <Link
        href="/policies"
        className="inline-flex items-center gap-1 self-end rounded-sm text-xs font-medium text-muted transition-colors duration-150 focus-ring hover:text-fg"
      >
        Change limits and wallet
        <ArrowRight aria-hidden="true" className="size-3" />
      </Link>
    </div>
  );
}
