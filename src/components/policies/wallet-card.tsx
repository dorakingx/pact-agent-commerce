"use client";

import { useState } from "react";
import { CircleCheck, CircleDashed, Hand, ShieldCheck, Unplug, Users, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Skeleton } from "@/components/ui/skeleton";
import { TONE_CLASSES, type StatusTone } from "@/components/ui/tone";
import { toast } from "@/components/ui";
import type { WalletStatus } from "@/lib/api/dto";
import { UNUSABLE_APPROVE_URL, describeWallet, resolveApproveUrl, toFailure, type Failure, type WalletState } from "@/lib/client/policy-derive";
import type { UseWallet } from "@/lib/client/use-wallet";
import { OperatorPanel } from "./operator-panel";
import { RequestError } from "./request-error";

const STATE_ICON: Record<WalletState, React.ReactNode> = {
  connected: <CircleCheck />,
  pending: <CircleDashed />,
  shared: <Users />,
  interactive: <Hand />,
  unsupported: <Hand />,
};

const PROVIDER_LABEL: Record<WalletStatus["provider"], string> = {
  paypal_sandbox: "PayPal Sandbox",
  simulated: "Simulated",
};

function WalletFacts({ status }: { status: WalletStatus }) {
  const delegated = status.effectiveMode === "delegated";
  return (
    <dl className="grid gap-px overflow-hidden rounded-control border border-hairline bg-hairline text-[13px] leading-5 sm:grid-cols-2">
      <div className="bg-surface px-4 py-3" data-testid="wallet-effective-mode" data-mode={status.effectiveMode}>
        <dt className="text-xs text-muted">Next in-policy deal</dt>
        <dd className="mt-0.5 font-medium text-fg">{delegated ? "Authorized by the agent wallet" : "You approve it in PayPal"}</dd>
        <dd className="mt-0.5 text-xs leading-[18px] text-muted">
          {delegated ? "No PayPal login. Funds are held, not captured." : "The hold is placed only after your approval."}
        </dd>
      </div>
      <div className="bg-surface px-4 py-3" data-testid="wallet-demo-status" data-connected={status.demo.connected}>
        <dt className="text-xs text-muted">Shared demo wallet</dt>
        <dd className="mt-0.5 flex items-center gap-1.5 font-medium text-fg">
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", status.demo.connected ? "bg-success" : "bg-neutral")} />
          {status.demo.connected ? "Connected" : "Not connected"}
        </dd>
        <dd className="mt-0.5 text-xs leading-[18px] text-muted">
          Managed by the operator. Used when a session has no wallet of its own.
        </dd>
      </div>
    </dl>
  );
}

function WalletSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-control" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
      </div>
      <Skeleton className="h-[74px] w-full rounded-control" />
    </div>
  );
}

export interface WalletCardProps {
  wallet: UseWallet;
  className?: string;
}

/** The delegated agent wallet: the trust model, this session's wallet, the shared demo wallet. */
export function WalletCard({ wallet, className }: WalletCardProps) {
  const { data: status, error, isLoading, connect, disconnect, reload } = wallet;
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onConnect() {
    setPending("connect");
    setFailure(null);
    try {
      const target = resolveApproveUrl(await connect("session"), window.location.origin);
      if (target !== null) {
        // Leaves the page: PayPal's consent screen, or with simulated payments a local return that
        // completes at once. The button stays busy until the browser has navigated.
        window.location.assign(target);
        return;
      }
      setFailure(UNUSABLE_APPROVE_URL);
    } catch (cause) {
      setFailure(toFailure(cause));
    }
    setPending(null);
  }

  async function onDisconnect() {
    setPending("disconnect");
    setFailure(null);
    try {
      await disconnect("session");
      toast.success("Wallet disconnected", { description: "New deals need your approval in PayPal, unless the shared demo wallet is connected." });
    } catch (cause) {
      setFailure(toFailure(cause));
    } finally {
      setPending(null);
    }
  }

  const summary = status ? describeWallet(status) : null;
  const tone: StatusTone = summary?.tone ?? "neutral";

  return (
    <Card data-testid="wallet-card" className={className}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle as="h2" className="flex items-center gap-2">
            <Wallet aria-hidden="true" className="size-4 text-muted" />
            Delegated agent wallet
          </CardTitle>
          {status ? (
            <Badge tone={status.provider === "simulated" ? "hold" : "success"} variant="outline" data-testid="wallet-provider">
              {PROVIDER_LABEL[status.provider]}
            </Badge>
          ) : null}
        </div>
        <CardDescription className="max-w-3xl text-pretty">
          Give consent in PayPal once, and the buyer agent can place authorization holds for in-policy deals without a
          PayPal login. The wallet carries no spending cap of its own: the limits on this page are enforced by
          PACT&rsquo;s policy engine, in code, before any PayPal call — never by the model.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading && !status ? <WalletSkeleton /> : null}
        {error && !status ? (
          <RequestError title="The wallet status could not be loaded" error={error} onRetry={reload} testId="wallet-error" />
        ) : null}
        {status && summary ? (
          <>
            <div
              data-testid="wallet-status"
              data-state={summary.state}
              className="flex flex-col gap-4 rounded-control border border-hairline bg-subtle/60 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span
                  aria-hidden="true"
                  className={cn("flex size-10 shrink-0 items-center justify-center rounded-control [&_svg]:size-5", TONE_CLASSES[tone].soft, TONE_CLASSES[tone].text)}
                >
                  {STATE_ICON[summary.state]}
                </span>
                <div className="min-w-0">
                  <p className="text-[15px] leading-6 font-semibold text-fg">{summary.title}</p>
                  {status.session.payerEmailMasked ? (
                    <p className="font-mono text-xs leading-5 text-muted" data-testid="wallet-payer">
                      {status.session.payerEmailMasked}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-[13px] leading-5 text-pretty text-muted">{summary.description}</p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2.5">
                {summary.canDisconnect ? (
                  <Button
                    variant="secondary"
                    data-testid="wallet-disconnect"
                    loading={pending === "disconnect"}
                    disabled={pending !== null}
                    onClick={onDisconnect}
                  >
                    {pending === "disconnect" ? null : <Unplug aria-hidden="true" />}
                    {summary.state === "pending" ? "Cancel connection" : "Disconnect"}
                  </Button>
                ) : null}
                {summary.canConnect ? (
                  <Button data-testid="wallet-connect" loading={pending === "connect"} disabled={pending !== null} onClick={onConnect}>
                    {summary.state === "pending" ? "Start again" : "Connect PayPal wallet"}
                  </Button>
                ) : null}
              </div>
            </div>
            {failure ? (
              <Callout tone="danger" title="That did not work" data-testid="wallet-action-error">
                {failure.message}
                {failure.requestId ? <span className="mt-1 block font-mono text-[11px] text-muted">Request {failure.requestId}</span> : null}
              </Callout>
            ) : null}
            {status.provider === "simulated" && summary.canConnect ? (
              <p className="flex items-start gap-2 text-[13px] leading-5 text-pretty text-muted" data-testid="wallet-simulated-note">
                <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-hold" />
                Payments are simulated in this deployment, so connecting completes at once with a simulated wallet. No PayPal
                account is involved.
              </p>
            ) : null}
            <WalletFacts status={status} />
            <OperatorPanel wallet={wallet} demoConnected={status.demo.connected} supportsVault={status.supportsVault} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
