import { describe, expect, it, vi } from "vitest";
import { opsRow, snapshotOf } from "@/lib/client/studio-fixtures";
import { createStudioContextHandle } from "./context";

describe("the context handed to AG Studio", () => {
  it("is one stable object that always reads the dashboard's latest snapshot and callback", () => {
    const first = snapshotOf([opsRow("completed", { code: "PACT-AAAA" })]);
    const second = snapshotOf([opsRow("in_review", { code: "PACT-BBBB" })]);
    const openFirst = vi.fn();
    const openSecond = vi.fn();

    const handle = createStudioContextHandle({ snapshot: first, onOpenDeal: openFirst });
    const { context } = handle;
    expect(context.snapshot()).toBe(first);
    context.openDeal("deal_1");
    expect(openFirst).toHaveBeenCalledWith("deal_1");

    handle.update({ snapshot: second, onOpenDeal: openSecond });
    expect(handle.context).toBe(context);
    expect(context.snapshot()).toBe(second);
    context.openDeal("deal_2");
    expect(openSecond).toHaveBeenCalledWith("deal_2");
    expect(openFirst).toHaveBeenCalledTimes(1);
  });

  it("finds a deal by code regardless of case and surrounding space, in the current snapshot only", () => {
    const row = opsRow("completed", { code: "PACT-7K2Q" });
    const handle = createStudioContextHandle({ snapshot: snapshotOf([row]), onOpenDeal: () => undefined });
    expect(handle.context.dealByCode("pact-7k2q")).toBe(row);
    expect(handle.context.dealByCode("  PACT-7K2Q ")).toBe(row);
    expect(handle.context.dealByCode("PACT-0000")).toBeNull();

    handle.update({ snapshot: snapshotOf([]), onOpenDeal: () => undefined });
    expect(handle.context.dealByCode("PACT-7K2Q")).toBeNull();
  });
});
