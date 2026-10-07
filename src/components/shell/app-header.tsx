import Link from "next/link";
import { PactLogo } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { GitHubIcon } from "./github-icon";
import { LiveSystemStatus } from "./live-system-status";
import { MobileNav } from "./mobile-nav";
import { GITHUB_URL } from "./nav";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

export interface AppHeaderProps {
  /**
   * Element shown as the system status. Defaults to `<LiveSystemStatus>`, which reads
   * GET /api/health; pass something else only to replace it (it is then hidden below `lg`).
   */
  statusSlot?: React.ReactNode;
  className?: string;
}

/** Sticky application header: logo, primary navigation, system status, theme toggle, GitHub. */
export function AppHeader({ statusSlot, className }: AppHeaderProps) {
  return (
    <header className={cn("sticky top-0 z-40 border-b border-hairline bg-canvas", className)}>
      <div className="container-page flex h-15 items-center gap-2 sm:gap-6">
        <Link href="/" aria-label="PACT home" className="-ml-1 inline-flex items-center rounded-control p-1 focus-ring pointer-coarse:min-h-11">
          <PactLogo />
        </Link>
        <NavLinks className="hidden md:flex" />
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {statusSlot ? (
            <div className="mr-1 hidden lg:block">{statusSlot}</div>
          ) : (
            // The live status collapses to an icon between md and lg, so tablets keep it too.
            <div className="hidden md:block lg:mr-1">
              <LiveSystemStatus compactBelowLg />
            </div>
          )}
          <ThemeToggle />
          <Tooltip content="View source on GitHub" side="bottom">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="PACT on GitHub"
              className={cn(buttonVariants({ variant: "ghost", size: "sm", iconOnly: true }), "hidden sm:inline-flex")}
            >
              <GitHubIcon />
            </a>
          </Tooltip>
          <MobileNav statusSlot={statusSlot ?? <LiveSystemStatus testId="system-status-drawer" />} className="md:hidden" />
        </div>
      </div>
    </header>
  );
}
