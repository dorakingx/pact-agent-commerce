import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";
import { Spinner } from "./spinner";

export const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap select-none",
    "transition-colors duration-150 ease-out focus-ring",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    // Touch devices get a 44px minimum target regardless of the visual size.
    "pointer-coarse:min-h-11",
  ],
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent hover:bg-accent-hover",
        secondary: "border border-hairline-strong bg-surface text-fg hover:bg-subtle",
        ghost: "text-fg hover:bg-subtle-strong/70",
        danger: "bg-danger-solid text-on-danger hover:bg-danger-solid-hover",
      },
      size: {
        sm: "h-8 px-3 text-[13px] [&_svg]:size-3.5",
        md: "h-10 px-4 text-sm [&_svg]:size-4",
        lg: "h-11 px-5 text-[15px] [&_svg]:size-[18px]",
      },
      /** Square button for a single icon. Always pair with `aria-label`. */
      iconOnly: { true: "px-0 pointer-coarse:min-w-11", false: "" },
      fullWidth: { true: "w-full", false: "" },
    },
    compoundVariants: [
      { iconOnly: true, size: "sm", class: "w-8" },
      { iconOnly: true, size: "md", class: "w-10" },
      { iconOnly: true, size: "lg", class: "w-11" },
    ],
    defaultVariants: { variant: "primary", size: "md", iconOnly: false, fullWidth: false },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export interface ButtonProps extends React.ComponentProps<"button">, ButtonVariantProps {
  /** Shows a spinner and blocks interaction while an action is in flight. */
  loading?: boolean;
}

export function Button({
  variant,
  size,
  iconOnly,
  fullWidth,
  loading = false,
  disabled,
  type = "button",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, iconOnly, fullWidth }), className)}
      {...props}
    >
      {loading ? <Spinner label={null} /> : null}
      {/* An icon-only button has no room for both: the spinner replaces the icon. */}
      {loading && iconOnly ? null : children}
    </button>
  );
}

export interface LinkButtonProps
  extends Omit<React.ComponentProps<typeof Link>, "className">,
    ButtonVariantProps {
  className?: string;
  /** Opens in a new tab with a safe `rel`. Use for links that leave PACT. */
  external?: boolean;
}

/** A navigation link that looks like a button. Use `Button` for actions, `LinkButton` for destinations. */
export function LinkButton({ variant, size, iconOnly, fullWidth, external = false, className, ...props }: LinkButtonProps) {
  return (
    <Link
      className={cn(buttonVariants({ variant, size, iconOnly, fullWidth }), className)}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...props}
    />
  );
}
