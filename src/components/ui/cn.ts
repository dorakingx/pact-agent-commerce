import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * tailwind-merge only knows Tailwind's default scales. Registering PACT's custom radius, shadow
 * and animation keys lets a caller's `rounded-none` or `shadow-none` reliably override them.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["control", "card"],
      shadow: ["pop"],
      animate: [
        "fade-in",
        "fade-out",
        "pop-in",
        "rise-in",
        "slide-in-right",
        "slide-out-right",
        "slide-in-left",
        "slide-out-left",
        "slide-in-bottom",
        "slide-out-bottom",
        "pulse-dot",
        "shimmer",
        "dash",
      ],
    },
  },
});

/** Merge class names; later Tailwind utilities win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
