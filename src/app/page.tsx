import type { Metadata } from "next";
import { Boundaries, BuiltWith, FinalCta, Hero, Pillars, Problem, Scenarios } from "@/components/marketing";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  // The landing page uses the full product name instead of the "%s · PACT" template.
  title: { absolute: "PACT — Programmable Agent Commerce Trust" },
};

/** Landing page. Fully static: it reads nothing from the backend. */
export default function LandingPage() {
  return (
    <AppShell width="full">
      <Hero />
      <Problem />
      <Pillars />
      <Scenarios />
      <Boundaries />
      <BuiltWith />
      <FinalCta />
    </AppShell>
  );
}
