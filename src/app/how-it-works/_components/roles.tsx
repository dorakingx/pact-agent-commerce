import { Bot, Landmark, Scale, ShieldCheck, UserCheck } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { HUMAN_GATES, ROLES, type Role } from "../content";

const ROLE_STYLE: Record<Role["id"], { icon: React.ReactNode; tile: string; marker: string; rule: string }> = {
  models: { icon: <Bot />, tile: "bg-info-soft text-info", marker: "bg-info", rule: "bg-info" },
  code: { icon: <Scale />, tile: "bg-accent-soft text-accent", marker: "bg-accent", rule: "bg-accent" },
  paypal: { icon: <Landmark />, tile: "bg-hold-soft text-hold", marker: "bg-hold", rule: "bg-hold" },
};

function RoleColumn({ role, index }: { role: Role; index: number }) {
  const style = ROLE_STYLE[role.id];
  return (
    <li data-testid={`role-${role.id}`} className="relative flex flex-col bg-canvas p-6 sm:p-7">
      {/* A rule in the role's colour ties the column to the lifecycle colours used across the product. */}
      <span aria-hidden="true" className={cn("absolute inset-x-0 top-0 h-0.5", style.rule)} />
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className={cn("flex size-10 shrink-0 items-center justify-center rounded-control [&_svg]:size-5", style.tile)}>
          {style.icon}
        </span>
        <p className="font-mono text-[11px] leading-4 font-medium tracking-[0.08em] text-muted uppercase">
          <span className="text-faint tabular-nums">{String(index + 1).padStart(2, "0")}</span>
          <span className="mx-1.5 text-faint">/</span>
          {role.kicker}
        </p>
      </div>
      <h3 className="mt-5 text-lg leading-7 font-semibold tracking-[-0.015em] text-balance text-fg">{role.title}</h3>
      <p className="mt-1 text-sm leading-6 text-muted">{role.summary}</p>
      <ul className="mt-5 flex flex-col gap-3.5">
        {role.items.map((item) => (
          <li key={item.name} className="flex gap-3">
            <span aria-hidden="true" className={cn("mt-[9px] size-1.5 shrink-0 rounded-full", style.marker)} />
            <p className="text-sm leading-6 text-pretty text-muted">
              <span className="font-semibold text-fg">{item.name}.</span> {item.detail}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-auto flex gap-2.5 pt-6 text-[13px] leading-5 text-pretty text-fg">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
        {role.boundary}
      </p>
    </li>
  );
}

/** The design rule as three columns of who does what, and the points where a person decides. */
export function Roles() {
  return (
    <>
      <ol className="grid gap-px overflow-hidden rounded-card border border-hairline bg-hairline lg:grid-cols-3">
        {ROLES.map((role, index) => (
          <RoleColumn key={role.id} role={role} index={index} />
        ))}
      </ol>
      <div data-testid="human-gates" className="mt-4 rounded-card border border-review/25 bg-review-soft/50 p-6 sm:p-7">
        <div className="grid gap-6 lg:grid-cols-12 lg:items-start">
          <div className="lg:col-span-4">
            <p className="flex items-center gap-2.5 text-[15px] leading-6 font-semibold text-fg">
              <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-control bg-review-soft text-review [&_svg]:size-4">
                <UserCheck />
              </span>
              And a person decides when code will not
            </p>
            <p className="mt-2 text-sm leading-6 text-pretty text-muted">
              When a rule cannot settle something, the engine stops and waits. It never asks a model to break the tie.
            </p>
          </div>
          <ol className="grid gap-4 sm:grid-cols-3 lg:col-span-8">
            {HUMAN_GATES.map((gate) => (
              <li key={gate.name} className="border-l-2 border-review/40 pl-3.5">
                <p className="text-sm leading-6 font-semibold text-fg">{gate.name}</p>
                <p className="mt-0.5 text-[13px] leading-5 text-pretty text-muted">{gate.when}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </>
  );
}
