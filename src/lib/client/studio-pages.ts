/**
 * Page navigation for the dashboard. AG Studio keeps a report's pages and the selected one in
 * its state but draws no control for them, so the header strip does: these helpers produce the
 * next state for "show this page", "add a page" and "remove a page". Each returns a new object
 * and leaves untouched pages as the same references, which is how Studio knows what changed.
 */
import { PAGE_TITLE, type PactPageId } from "./studio-report";

export interface PagedState {
  pages: { id: string }[];
  selectedPageId: string;
}

const CUSTOM_PAGE_PREFIX = "page-";

export function isBuiltInPage(id: string): id is PactPageId {
  return Object.hasOwn(PAGE_TITLE, id);
}

/** What a page is called on its tab: PACT's name for its own pages, "Page n" for added ones. */
export function pageLabel(id: string): string {
  if (isBuiltInPage(id)) return PAGE_TITLE[id];
  const number = id.startsWith(CUSTOM_PAGE_PREFIX) ? Number(id.slice(CUSTOM_PAGE_PREFIX.length)) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? `Page ${number}` : id;
}

export function withSelectedPage<T extends PagedState>(state: T, pageId: string): T {
  if (state.selectedPageId === pageId || !state.pages.some((page) => page.id === pageId)) return state;
  return { ...state, selectedPageId: pageId };
}

/** The lowest unused "page-n" id, so removing and re-adding a page does not keep counting up. */
export function nextPageId(state: PagedState): string {
  const taken = new Set(state.pages.map((page) => page.id));
  let number = 1;
  while (taken.has(`${CUSTOM_PAGE_PREFIX}${number}`)) number += 1;
  return `${CUSTOM_PAGE_PREFIX}${number}`;
}

/** Append an empty page and show it. */
export function withNewPage<T extends PagedState>(state: T): T {
  const id = nextPageId(state);
  const blank = { id, widgets: {}, widgetLayout: {} };
  return { ...state, pages: [...state.pages, blank], selectedPageId: id };
}

/**
 * Remove a page. The last remaining page is never removed (a report needs one), and removing the
 * page on screen moves to its left neighbour, the way closing a tab does.
 */
export function withoutPage<T extends PagedState>(state: T, pageId: string): T {
  const index = state.pages.findIndex((page) => page.id === pageId);
  if (index === -1 || state.pages.length <= 1) return state;
  const pages = state.pages.filter((page) => page.id !== pageId);
  const selectedPageId = state.selectedPageId === pageId ? pages[Math.max(0, index - 1)]!.id : state.selectedPageId;
  return { ...state, pages, selectedPageId };
}
