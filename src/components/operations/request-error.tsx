import { RotateCw } from "lucide-react";
import { Button, Callout, type CalloutTone } from "@/components/ui";
import type { ApiClientError } from "@/lib/client/api";

export interface OpsRequestErrorProps {
  title: string;
  error: ApiClientError;
  onRetry: () => void;
  /** `danger` when nothing could be shown; `warning` when older data is still on screen. */
  tone?: Extract<CalloutTone, "danger" | "warning">;
  testId?: string;
  className?: string;
}

/** Error state of a read: what failed, the request id to quote from the logs, and a way to try again. */
export function OpsRequestError({ title, error, onRetry, tone = "danger", testId, className }: OpsRequestErrorProps) {
  return (
    <Callout
      tone={tone}
      title={title}
      data-testid={testId}
      className={className}
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCw aria-hidden="true" />
          Retry
        </Button>
      }
    >
      {error.message}
      {error.requestId ? <span className="mt-1 block font-mono text-[11px] text-muted">Request {error.requestId}</span> : null}
    </Callout>
  );
}
