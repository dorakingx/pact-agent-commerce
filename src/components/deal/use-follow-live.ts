"use client";

import { useEffect, useRef } from "react";

/*
 * Keeps the newest part of a running deal in view, the way a chat follows its latest message,
 * but only for a viewer who is already looking at the live edge. Anyone who scrolled up to read
 * something is left alone until they come back down.
 *
 * Elements that can be "the newest part" mark themselves with `data-live-anchor`; the last one
 * in document order is the live edge.
 */

/** Space taken by the app header and the sticky deal bar. */
const TOP_CHROME_PX = 150;
const BOTTOM_SLACK_PX = 24;
/** Scroll events during our own smooth scroll say nothing about what the viewer wants. */
const OWN_SCROLL_MS = 900;

function partlyInView(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom > TOP_CHROME_PX && rect.top < window.innerHeight - BOTTOM_SLACK_PX;
}

function fullyInView(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.top >= TOP_CHROME_PX - 8 && rect.bottom <= window.innerHeight - BOTTOM_SLACK_PX + 8;
}

/**
 * @param container        The element whose `[data-live-anchor]` descendants are tracked.
 * @param version          Changes whenever the deal may have gained a new anchor.
 * @param startAtLiveEdge  Open the page at the newest part instead of the top. For a deal that is
 *                         still moving (a reload mid-run, the return from the approval page) the
 *                         top of the page is history; a finished deal is read from the beginning.
 */
export function useFollowLive(container: React.RefObject<HTMLElement | null>, version: string, startAtLiveEdge: boolean): void {
  const state = useRef<{ anchor: Element | null; following: boolean; ownScrollUntil: number }>({
    anchor: null,
    following: false,
    ownScrollUntil: 0,
  });

  useEffect(() => {
    const onScroll = (): void => {
      const current = state.current;
      if (performance.now() < current.ownScrollUntil) return;
      current.following = current.anchor !== null && current.anchor.isConnected && partlyInView(current.anchor);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const root = container.current;
    if (root === null) return;
    const anchors = root.querySelectorAll("[data-live-anchor]");
    const next = anchors.length === 0 ? null : anchors[anchors.length - 1];
    const current = state.current;
    if (next === current.anchor) return;

    const firstSight = current.anchor === null;
    const wasFollowing = current.following;
    current.anchor = next;
    if (next === null) return;
    if (firstSight && startAtLiveEdge && !partlyInView(next)) {
      // An instant jump, not an animation: the page has only just appeared.
      next.scrollIntoView({ block: "nearest", behavior: "auto" });
      current.following = true;
      return;
    }
    if (firstSight || !wasFollowing) {
      current.following = partlyInView(next);
      return;
    }
    if (!fullyInView(next)) {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      current.ownScrollUntil = performance.now() + OWN_SCROLL_MS;
      next.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    }
    current.following = true;
  }, [container, version, startAtLiveEdge]);
}
