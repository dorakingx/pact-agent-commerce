"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useTheme } from "@/components/ui/use-theme";

/**
 * Light/dark switch. Both icons are rendered and CSS picks one from `data-theme`, so the
 * correct icon is painted before React hydrates.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <Tooltip content={label} side="bottom">
      <Button variant="ghost" size="sm" iconOnly aria-label={label} onClick={toggleTheme} className={className}>
        <Sun aria-hidden="true" className="hidden dark:block" />
        <Moon aria-hidden="true" className="dark:hidden" />
      </Button>
    </Tooltip>
  );
}
