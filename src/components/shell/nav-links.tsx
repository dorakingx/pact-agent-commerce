"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { NAV_ITEMS, isActivePath } from "./nav";

/** Desktop primary navigation. The active page is marked with `aria-current` as well as visually. */
export function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className={cn("items-center gap-1", className)}>
      {NAV_ITEMS.map((item) => {
        const active = isActivePath(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center rounded-control px-3 text-sm font-medium transition-colors duration-150 ease-out focus-ring",
              active ? "bg-subtle-strong text-fg" : "text-muted hover:bg-subtle-strong/60 hover:text-fg",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
