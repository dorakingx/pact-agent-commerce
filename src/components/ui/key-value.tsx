import { cn } from "./cn";

export interface KeyValueListProps extends React.ComponentProps<"dl"> {
  /** `row`: label left, value right. `stack`: label above value. */
  layout?: "row" | "stack";
  /** Draw a hairline between rows. */
  divided?: boolean;
  dense?: boolean;
}

/** A description list for facts: contract terms, payment ids, policy limits. */
export function KeyValueList({ layout = "row", divided = false, dense = false, className, ...props }: KeyValueListProps) {
  return (
    <dl
      data-layout={layout}
      data-dense={dense ? "" : undefined}
      className={cn(
        "group/kv text-sm",
        layout === "stack" ? "grid gap-4" : "flex flex-col",
        divided && layout === "row" && "divide-y divide-hairline",
        className,
      )}
      {...props}
    />
  );
}

export interface KeyValueProps extends Omit<React.ComponentProps<"div">, "children"> {
  label: React.ReactNode;
  children: React.ReactNode;
}

export function KeyValue({ label, children, className, ...props }: KeyValueProps) {
  return (
    <div
      className={cn(
        "flex min-w-0",
        "group-data-[layout=row]/kv:items-baseline group-data-[layout=row]/kv:justify-between group-data-[layout=row]/kv:gap-4 group-data-[layout=row]/kv:py-2 group-data-[layout=row]/kv:group-data-[dense]/kv:py-1.5",
        "group-data-[layout=stack]/kv:flex-col group-data-[layout=stack]/kv:gap-1",
        className,
      )}
      {...props}
    >
      <dt className="shrink-0 text-muted group-data-[layout=stack]/kv:text-xs group-data-[layout=stack]/kv:font-medium">
        {label}
      </dt>
      <dd className="min-w-0 font-medium text-fg group-data-[layout=row]/kv:text-right">{children}</dd>
    </div>
  );
}
