"use client";

import { useSyncExternalStore } from "react";
import { formatRelativeTime, formatUtcDateTime, toEpochMs } from "./format";

/*
 * One shared clock for every <RelativeTime> on the page: a single interval instead of one per
 * instance, and all labels tick together.
 */
const TICK_MS = 15_000;
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;
let now = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (interval === null) {
    now = Date.now();
    interval = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

function getSnapshot(): number {
  // Before the first subscription there is no ticking value yet; read the clock once.
  if (now === 0) now = Date.now();
  return now;
}

/** The server has no meaningful "now": render the absolute time there and during hydration. */
function getServerSnapshot(): null {
  return null;
}

export interface RelativeTimeProps extends Omit<React.ComponentProps<"time">, "children" | "dateTime"> {
  /** ISO-8601 string, epoch milliseconds or Date. */
  value: string | number | Date;
}

/**
 * "5 min ago" / "in 3 h", updating as time passes. Hydration-safe: the server and the first
 * client render show the absolute UTC time, then the label switches to relative.
 */
export function RelativeTime({ value, title, ...props }: RelativeTimeProps) {
  const current = useSyncExternalStore<number | null>(subscribe, getSnapshot, getServerSnapshot);
  const target = toEpochMs(value);
  const absolute = formatUtcDateTime(target);
  const valid = !Number.isNaN(target);
  return (
    <time dateTime={valid ? new Date(target).toISOString() : undefined} title={title ?? absolute} {...props}>
      {current === null ? absolute : formatRelativeTime(target, current)}
    </time>
  );
}
