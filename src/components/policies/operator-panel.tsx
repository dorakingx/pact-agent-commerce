"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useSWRConfig } from "swr";
import { toast } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiClientError } from "@/lib/client/api";
import { UNUSABLE_APPROVE_URL, resolveApproveUrl, toFailure, type Failure } from "@/lib/client/policy-derive";
import { HEALTH_KEY } from "@/lib/client/use-system-status";
import type { UseWallet } from "@/lib/client/use-wallet";

/**
 * The token is kept for this tab only: connecting leaves for PayPal and comes back, and the
 * operator should not have to paste it again to disconnect. sessionStorage dies with the tab.
 */
const TOKEN_STORAGE_KEY = "pact:operator-token";

function readStoredToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    // Storage can be unavailable (privacy modes); the token then simply is not remembered.
    return "";
  }
}

function storeToken(token: string | null): void {
  try {
    if (token === null) window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    else window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // See readStoredToken.
  }
}

interface OperatorControlsProps {
  wallet: UseWallet;
  demoConnected: boolean;
  supportsVault: boolean;
}

/** Mounted only once the disclosure is opened, so session storage is never read during hydration. */
function OperatorControls({ wallet, demoConnected, supportsVault }: OperatorControlsProps) {
  const tokenId = useId();
  const hintId = useId();
  const errorId = useId();
  const { mutate } = useSWRConfig();
  const [token, setToken] = useState(readStoredToken);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const adminToken = token.trim();
    if (adminToken === "") {
      setFailure({ message: "Paste the operator token first.", requestId: null });
      return;
    }
    setBusy(true);
    setFailure(null);
    storeToken(adminToken);
    try {
      if (demoConnected) {
        await wallet.disconnect("demo", { adminToken });
        // The header's status popover reports this wallet too.
        void mutate(HEALTH_KEY);
        toast.success("Shared demo wallet disconnected", { description: "Sessions without their own wallet now approve each deal in PayPal." });
      } else {
        const target = resolveApproveUrl(await wallet.connect("demo", { adminToken }), window.location.origin);
        if (target !== null) {
          window.location.assign(target);
          return;
        }
        setFailure(UNUSABLE_APPROVE_URL);
      }
    } catch (cause) {
      // A refused token is not worth remembering.
      if (cause instanceof ApiClientError && cause.status === 403) storeToken(null);
      setFailure(toFailure(cause));
    }
    setBusy(false);
  }

  function onForget() {
    storeToken(null);
    setToken("");
    setFailure(null);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-3 flex flex-col gap-3 rounded-control border border-dashed border-hairline-strong px-4 py-3.5">
      <p className="text-xs leading-[18px] text-pretty text-muted">
        For whoever runs this deployment. Connecting the shared demo wallet lets every visitor watch a delegated
        authorization without a PayPal login of their own.
      </p>
      <div className="flex flex-col gap-1.5 sm:max-w-md">
        <Label htmlFor={tokenId} className="text-[13px]">
          Operator token
        </Label>
        <Input
          id={tokenId}
          data-testid="operator-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          disabled={busy}
          aria-invalid={failure ? true : undefined}
          aria-describedby={failure ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => setToken(event.target.value)}
          className="font-mono"
        />
        <p id={hintId} className="text-xs leading-[18px] text-muted">
          Sent only as a request header. Kept in this tab until it closes or you forget it.
        </p>
      </div>
      {failure ? (
        <p id={errorId} role="alert" data-testid="operator-error" className="text-xs leading-[18px] font-medium text-danger">
          {failure.message}
          {failure.requestId ? <span className="mt-0.5 block font-mono text-[11px] font-normal text-muted">Request {failure.requestId}</span> : null}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          data-testid="operator-submit"
          loading={busy}
          disabled={!supportsVault && !demoConnected}
        >
          {demoConnected ? "Disconnect shared wallet" : "Connect shared wallet"}
        </Button>
        <Button variant="ghost" size="sm" data-testid="operator-forget" disabled={busy || token === ""} onClick={onForget}>
          Forget token
        </Button>
      </div>
    </form>
  );
}

export type OperatorPanelProps = OperatorControlsProps;

/** Collapsed by default and visually quiet: visitors of the demo have no use for it. */
export function OperatorPanel(props: OperatorPanelProps) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  return (
    <div data-testid="operator-panel">
      <button
        type="button"
        data-testid="operator-toggle"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-sm text-xs leading-5 font-medium text-muted transition-colors duration-150 ease-out focus-ring hover:text-fg pointer-coarse:min-h-11"
      >
        <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform duration-150 ease-out", open && "rotate-180")} />
        Operator
      </button>
      <div id={regionId} hidden={!open}>
        {open ? <OperatorControls {...props} /> : null}
      </div>
    </div>
  );
}
