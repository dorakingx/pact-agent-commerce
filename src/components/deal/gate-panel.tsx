"use client";

import { useState } from "react";
import { UserCheck } from "lucide-react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  type ButtonProps,
} from "@/components/ui";
import type { HumanGate } from "@/lib/api/dto";
import type { ApiClientError } from "@/lib/client/api";
import { RequestError } from "./parts";

export interface GatePanelProps {
  gate: HumanGate;
  title: string;
  /** What is being asked, in one or two sentences. */
  children: React.ReactNode;
  /** The headline fact of the decision (usually the amount). */
  figure?: React.ReactNode;
  actions: React.ReactNode;
  /** The last decision that failed, shown until the next attempt. */
  error?: ApiClientError | null;
}

/**
 * A human gate. It is the only violet block on the page and the only one with a solid border,
 * so that while a decision is open nothing else competes with it.
 */
export function GatePanel({ gate, title, children, figure, actions, error }: GatePanelProps) {
  const titleId = `gate-${gate}-title`;
  return (
    <div
      id={`gate-${gate}`}
      role="region"
      aria-labelledby={titleId}
      data-testid={`gate-${gate}`}
      data-live-anchor=""
      className="animate-rise-in scroll-mt-44 scroll-mb-10 rounded-card border-2 border-review bg-review-soft p-4 sm:p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-mono text-[11px] leading-4 font-medium tracking-[0.08em] text-review uppercase">
            <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-full bg-review text-surface [&_svg]:size-3.5">
              <UserCheck />
            </span>
            Your decision
          </p>
          <h3 id={titleId} className="mt-2.5 text-lg leading-7 font-semibold tracking-[-0.015em] text-fg">
            {title}
          </h3>
          <div className="mt-1 max-w-2xl text-sm leading-6 text-fg/85">{children}</div>
        </div>
        {figure ? <div className="shrink-0 sm:text-right">{figure}</div> : null}
      </div>
      {error ? <RequestError error={error} title="The decision was not recorded" className="mt-4" /> : null}
      <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">{actions}</div>
    </div>
  );
}

export interface ConfirmActionProps {
  /** The button that opens the dialog. */
  trigger: { label: string; variant?: ButtonProps["variant"]; testId: string; icon?: React.ReactNode; disabled?: boolean };
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  confirmTestId: string;
  /** Destructive confirmations get the danger button. */
  destructive?: boolean;
  /** Settles when the request has finished, whatever its outcome. */
  onConfirm(): Promise<unknown>;
}

/** A button whose action is irreversible: it asks once more, in a dialog, before acting. */
export function ConfirmAction({ trigger, title, description, confirmLabel, confirmTestId, destructive = true, onConfirm }: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm(): Promise<void> {
    setBusy(true);
    await onConfirm();
    setBusy(false);
    // Closes on failure too: the gate behind the dialog is where the error is shown.
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : setOpen(next))}>
      <DialogTrigger asChild>
        <Button variant={trigger.variant ?? "secondary"} disabled={trigger.disabled} data-testid={trigger.testId} className="max-sm:w-full">
          {trigger.icon}
          {trigger.label}
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader className="pb-6">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" disabled={busy}>
              Go back
            </Button>
          </DialogClose>
          <Button variant={destructive ? "danger" : "primary"} loading={busy} onClick={() => void confirm()} data-testid={confirmTestId}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
