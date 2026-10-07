import { cn } from "@/components/ui/cn";
import { AppFooter } from "./app-footer";
import { AppHeader } from "./app-header";
import { MAIN_CONTENT_ID } from "./nav";

export interface AppShellProps {
  children: React.ReactNode;
  /**
   * `page`: centered column with the standard gutter and vertical padding (most screens).
   * `full`: no container; the page lays out its own full-bleed sections (landing, dashboards).
   */
  width?: "page" | "full";
  /** Replaces the header's live system status. Leave unset to get `<LiveSystemStatus>` on every page. */
  statusSlot?: React.ReactNode;
  /** Hide the footer on app screens that manage the full viewport height. */
  hideFooter?: boolean;
  /** Applied to <main>. */
  className?: string;
}

/**
 * Frame for every page: header, <main> landmark (the skip-link target) and footer.
 * Expects the root layout's flex column <body>, so short pages still pin the footer down.
 */
export function AppShell({ children, width = "page", statusSlot, hideFooter = false, className }: AppShellProps) {
  return (
    <>
      <AppHeader statusSlot={statusSlot} />
      <main
        id={MAIN_CONTENT_ID}
        // Focusable so the skip link moves keyboard focus, not just the scroll position.
        tabIndex={-1}
        className={cn("flex-1 outline-none", width === "page" && "container-page py-8 sm:py-10", className)}
      >
        {children}
      </main>
      {hideFooter ? null : <AppFooter />}
    </>
  );
}
