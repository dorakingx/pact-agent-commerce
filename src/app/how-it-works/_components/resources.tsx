import { ArrowUpRight, BookOpen, Braces, ShieldCheck } from "lucide-react";
import { RESOURCES, type Resource } from "../content";

const ICON: Record<string, React.ReactNode> = {
  architecture: <BookOpen />,
  security: <ShieldCheck />,
  openapi: <Braces />,
};

function ResourceLink({ resource }: { resource: Resource }) {
  return (
    <a
      href={resource.href}
      data-testid={`resource-${resource.id}`}
      // The API description is a raw JSON file; like the GitHub docs it opens beside the product, not over it.
      target="_blank"
      rel="noopener noreferrer"
      className="group flex h-full flex-col rounded-card border border-hairline bg-surface p-5 transition-colors duration-150 ease-out focus-ring hover:border-hairline-strong"
    >
      <span className="flex items-center justify-between gap-3">
        <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-control bg-subtle text-muted [&_svg]:size-[18px]">
          {ICON[resource.id]}
        </span>
        <ArrowUpRight aria-hidden="true" className="size-4 text-faint transition-colors duration-150 ease-out group-hover:text-fg" />
      </span>
      <span className="mt-4 text-[15px] leading-6 font-semibold text-fg">{resource.title}</span>
      <span className="mt-1 text-[13px] leading-5 text-pretty text-muted">{resource.description}</span>
      <span className="mt-3 font-mono text-[11px] leading-4 text-faint">{resource.external ? "github.com · docs" : resource.href}</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Where the long form lives. */
export function Resources() {
  return (
    <ul className="grid gap-4 sm:grid-cols-3">
      {RESOURCES.map((resource) => (
        <li key={resource.id}>
          <ResourceLink resource={resource} />
        </li>
      ))}
    </ul>
  );
}
