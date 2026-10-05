import type { Metadata } from "next";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { AppShell } from "@/components/shell";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <AppShell className="flex items-center justify-center">
      <div className="flex flex-col items-center">
        <p className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">Error 404</p>
        <EmptyState
          as="h1"
          className="pt-5"
          icon={<FileQuestion />}
          title="No page is bound to this address"
          description="The link may be out of date, or the deal it pointed to belongs to another browser session. Nothing was charged, authorized or captured."
          action={
            <>
              <LinkButton href="/">
                <ArrowLeft aria-hidden="true" />
                Back to home
              </LinkButton>
              <LinkButton href="/workspace" variant="secondary">
                Open the workspace
              </LinkButton>
            </>
          }
        />
      </div>
    </AppShell>
  );
}
