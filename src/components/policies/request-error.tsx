import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import type { ApiClientError } from "@/lib/client/api";

export interface RequestErrorProps {
  title: string;
  error: ApiClientError;
  onRetry: () => void;
  testId?: string;
  className?: string;
}

/** Error state of a read: what failed, the request id to quote from the logs, and a way to try again. */
export function RequestError({ title, error, onRetry, testId, className }: RequestErrorProps) {
  return (
    <Callout
      tone="danger"
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
