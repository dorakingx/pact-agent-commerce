"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/**
 * False in the server render and during hydration, true once React owns the page.
 *
 * For buttons that are rendered on the server but only work through a client handler: until
 * hydration a click on them is lost (or, inside a form, posts the page to itself), so they are
 * disabled until then instead of looking ready.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
