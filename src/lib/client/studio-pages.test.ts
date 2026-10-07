import { describe, expect, it } from "vitest";
import { isBuiltInPage, nextPageId, pageLabel, withNewPage, withSelectedPage, withoutPage } from "./studio-pages";
import { buildDefaultReport } from "./studio-report";

const base = () => buildDefaultReport();

describe("page labels", () => {
  it("names PACT's own pages and numbers added ones", () => {
    expect(["overview", "ledger", "verification", "payments"].map(pageLabel)).toEqual(["Overview", "Ledger", "Verification", "Payments"]);
    expect(pageLabel("page-3")).toBe("Page 3");
    expect(pageLabel("imported")).toBe("imported");
    expect(isBuiltInPage("ledger")).toBe(true);
    expect(isBuiltInPage("page-1")).toBe(false);
    expect(isBuiltInPage("toString")).toBe(false);
  });
});

describe("withSelectedPage", () => {
  it("selects an existing page and keeps every page object as it was", () => {
    const state = base();
    const next = withSelectedPage(state, "ledger");
    expect(next.selectedPageId).toBe("ledger");
    expect(next).not.toBe(state);
    expect(next.pages).toBe(state.pages);
  });

  it("returns the same state for the current page or an unknown one", () => {
    const state = base();
    expect(withSelectedPage(state, "overview")).toBe(state);
    expect(withSelectedPage(state, "nowhere")).toBe(state);
  });
});

describe("withNewPage", () => {
  it("appends an empty page and shows it", () => {
    const state = base();
    const next = withNewPage(state);
    expect(next.pages).toHaveLength(5);
    expect(next.pages[4]).toEqual({ id: "page-1", widgets: {}, widgetLayout: {} });
    expect(next.selectedPageId).toBe("page-1");
    expect(next.pages.slice(0, 4)).toEqual(state.pages);
    expect(next.pages[0]).toBe(state.pages[0]);
  });

  it("reuses the lowest free number", () => {
    const three = withNewPage(withNewPage(withNewPage(base())));
    expect(three.pages.slice(4).map((page) => page.id)).toEqual(["page-1", "page-2", "page-3"]);
    const gap = withoutPage(three, "page-2");
    expect(nextPageId(gap)).toBe("page-2");
  });
});

describe("withoutPage", () => {
  it("removes a page and moves to its left neighbour when it was on screen", () => {
    const state = withNewPage(base());
    const next = withoutPage(state, "page-1");
    expect(next.pages.map((page) => page.id)).toEqual(["overview", "ledger", "verification", "payments"]);
    expect(next.selectedPageId).toBe("payments");
  });

  it("keeps the selection when another page is removed", () => {
    const state = withSelectedPage(withNewPage(base()), "ledger");
    expect(withoutPage(state, "page-1").selectedPageId).toBe("ledger");
  });

  it("moves to the new first page when the first one is removed", () => {
    expect(withoutPage(base(), "overview").selectedPageId).toBe("ledger");
  });

  it("never removes the last page, and ignores unknown ids", () => {
    const single = { pages: [{ id: "only" }], selectedPageId: "only" };
    expect(withoutPage(single, "only")).toBe(single);
    const state = base();
    expect(withoutPage(state, "nowhere")).toBe(state);
  });
});
