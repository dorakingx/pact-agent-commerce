import { Ban, Bot, UserCheck } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { TONE_CLASSES } from "@/components/ui/tone";
import type { SpendBand } from "@/lib/client/policy-derive";

const BAND_ICON: Record<SpendBand["id"], React.ReactNode> = {
  autonomous: <Bot />,
  approval: <UserCheck />,
  blocked: <Ban />,
};

/**
 * The limits as the three things that can happen to a purchase by size. Schematic, not to
 * scale: the point is where the boundaries are, and they move as the fields are edited.
 */
export function LimitBands({ bands, className }: { bands: readonly SpendBand[]; className?: string }) {
  return (
    <ul
      aria-label="What happens to a purchase, by amount"
      data-testid="policy-limit-bands"
      className={cn("grid gap-2 sm:auto-cols-fr sm:grid-flow-col sm:gap-1.5", className)}
    >
      {bands.map((band) => {
        const tone = TONE_CLASSES[band.tone];
        return (
          <li
            key={band.id}
            data-band={band.id}
            className="flex animate-fade-in items-center gap-3 sm:flex-col sm:items-stretch sm:gap-2.5"
          >
            <span aria-hidden="true" className={cn("h-9 w-1 shrink-0 rounded-full sm:h-1.5 sm:w-auto", tone.solid)} />
            <span className="flex min-w-0 items-start gap-2.5">
              <span aria-hidden="true" className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5", tone.soft, tone.text)}>
                {BAND_ICON[band.id]}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] leading-5 font-semibold text-fg">{band.title}</span>
                <span className="block font-mono text-xs leading-5 text-muted tabular-nums">{band.range}</span>
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
