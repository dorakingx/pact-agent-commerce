import { describe, expect, it } from "vitest";
import type { AgWidgetField } from "ag-studio";
import { mapped, planQuery, valueOf } from "./use-widget-rows";

const field = (key: string): AgWidgetField => ({ key, id: key }) as unknown as AgWidgetField;

describe("custom widget queries", () => {
  it("takes the first field an author mapped to a slot", () => {
    expect(mapped(undefined)).toBeUndefined();
    expect(mapped([])).toBeUndefined();
    expect(mapped([field("status"), field("seller")])).toEqual(field("status"));
  });

  it("reads a row's value by the field's key, and nothing for an unmapped slot", () => {
    const row = { status: "completed", amount: 4700 };
    expect(valueOf(row, field("amount"))).toBe(4700);
    expect(valueOf(row, field("missing"))).toBeUndefined();
    expect(valueOf(row, undefined)).toBeUndefined();
  });

  it("queries every mapped slot, required ones first, and is complete only when all required ones are mapped", () => {
    expect(planQuery([field("stage"), field("count")], [field("amount"), undefined])).toEqual({
      fields: [field("stage"), field("count"), field("amount")],
      complete: true,
    });
    expect(planQuery([field("stage"), undefined], [field("amount")])).toEqual({ fields: [field("stage"), field("amount")], complete: false });
    expect(planQuery([], [])).toEqual({ fields: [], complete: true });
  });
});
