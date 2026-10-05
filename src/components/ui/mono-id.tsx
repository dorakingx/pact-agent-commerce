"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "./cn";
import { truncateMiddle } from "./format";
import { Tooltip } from "./tooltip";

export interface MonoIdProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** The full id or hash. */
  value: string;
  /** What this value is, used for accessible names: "Copy terms hash". */
  label?: string;
  /** Characters kept at the start / end when truncating. */
  head?: number;
  tail?: number;
  /** Show the full value instead of `head…tail`. */
  full?: boolean;
  /** Render the copy button (default true). */
  copyable?: boolean;
}

const COPIED_FEEDBACK_MS = 1600;

/**
 * An id or hash in monospace with middle truncation. The full value is available in a tooltip
 * (hover or keyboard focus) and through the copy button.
 */
export function MonoId({
  value,
  label = "value",
  head = 6,
  tail = 4,
  full = false,
  copyable = true,
  className,
  ...props
}: MonoIdProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const shown = full ? value : truncateMiddle(value, head, tail);
  const truncated = shown !== value;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      // Clipboard access can be denied (insecure context, permissions). The full value stays
      // reachable through the tooltip, so failing silently loses nothing.
      setCopied(false);
    }
  }

  const text = (
    <span
      // Focusable only when there is hidden text to reveal, so keyboard users can read it.
      tabIndex={truncated ? 0 : undefined}
      aria-label={truncated ? `${label}: ${value}` : undefined}
      className={cn("rounded-sm font-mono text-[0.92em] tabular-nums", truncated && "focus-ring cursor-default")}
    >
      {shown}
    </span>
  );

  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 align-baseline", className)} {...props}>
      {truncated ? (
        <Tooltip content={<span className="font-mono break-all">{value}</span>}>{text}</Tooltip>
      ) : (
        text
      )}
      {copyable ? (
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
          className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors duration-150 ease-out focus-ring hover:bg-subtle hover:text-fg pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-['']"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5 text-success" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
        </button>
      ) : null}
      {/* Announces the copy without moving focus. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </span>
  );
}
