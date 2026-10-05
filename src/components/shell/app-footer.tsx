import { PactLogo } from "@/components/brand/logo";
import { cn } from "@/components/ui/cn";
import { GITHUB_URL, LICENSE_URL } from "./nav";

const LINK =
  "rounded-sm text-muted underline-offset-4 transition-colors duration-150 ease-out focus-ring hover:text-fg hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center";

/** Site footer. Carries the two disclaimers that must be visible on every page. */
export function AppFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("border-t border-hairline bg-canvas", className)}>
      <div className="container-page flex flex-col gap-6 py-8 md:flex-row md:items-start md:justify-between">
        <div className="flex max-w-2xl flex-col gap-3">
          <PactLogo size="sm" tone="mono" className="text-muted" />
          <div className="text-sm leading-6 text-muted">
            <p>Sandbox demo — no real money moves.</p>
            <p>PACT uses PayPal authorization and capture; it is not an escrow service.</p>
          </div>
        </div>
        <nav aria-label="Footer" className="flex items-center gap-5 text-sm">
          <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
            MIT License
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
