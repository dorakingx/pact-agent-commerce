"use client";

import { RotateCw, TriangleAlert } from "lucide-react";
import { AppShell } from "@/components/shell";
import { Button, LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { MonoId } from "@/components/ui/mono-id";

/**
 * Segment error boundary. The original error is already recorded on the server (Next.js logs it
 * with the same digest), so the page only needs to help the visitor recover and quote the
 * reference id.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <AppShell className="flex items-center justify-center">
      <div className="flex flex-col items-center">
        <p className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">Something went wrong</p>
        <EmptyState
          as="h1"
          className="pt-5"
          icon={<TriangleAlert />}
          title="This page failed to load"
          description="The problem is on our side. No payment step runs from a page render, so nothing was authorized or captured by this error. Trying again usually fixes it."
          action={
            <>
              <Button onClick={retry}>
                <RotateCw aria-hidden="true" />
                Try again
              </Button>
              <LinkButton href="/" variant="secondary">
                Back to home
              </LinkButton>
            </>
          }
        />
        {error.digest ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            Reference
            <MonoId value={error.digest} label="error reference" head={10} tail={6} />
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}
