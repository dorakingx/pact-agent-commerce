"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { PactLogo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { GitHubIcon } from "./github-icon";
import { GITHUB_URL, NAV_ITEMS, isActivePath } from "./nav";

export interface MobileNavProps {
  /** System status element, repeated here because the header hides it on small screens. */
  statusSlot?: React.ReactNode;
  className?: string;
}

/** Navigation drawer for small screens. Every link closes the drawer when followed. */
export function MobileNav({ statusSlot, className }: MobileNavProps) {
  const pathname = usePathname();
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" iconOnly aria-label="Open navigation" className={className}>
          <Menu aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" aria-describedby={undefined}>
        <SheetHeader className="py-2.5">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetClose asChild>
            <Link href="/" aria-label="PACT home" className="inline-flex min-h-11 w-fit items-center rounded-control focus-ring">
              <PactLogo />
            </Link>
          </SheetClose>
        </SheetHeader>
        <SheetBody className="px-3">
          <nav aria-label="Primary" className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const active = isActivePath(pathname, item.href);
              return (
                <SheetClose asChild key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-12 items-center rounded-control px-3 text-base font-medium transition-colors duration-150 ease-out focus-ring",
                      active ? "bg-subtle-strong text-fg" : "text-muted hover:bg-subtle hover:text-fg",
                    )}
                  >
                    {item.label}
                  </Link>
                </SheetClose>
              );
            })}
          </nav>
        </SheetBody>
        <SheetFooter className="flex-wrap justify-between">
          {statusSlot}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-control px-2 text-sm font-medium text-muted transition-colors duration-150 ease-out focus-ring hover:text-fg"
          >
            <GitHubIcon />
            GitHub
          </a>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
