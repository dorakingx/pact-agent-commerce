import { describe, expect, it } from "vitest";
import { DEAL_STATUSES } from "../domain/status";
import { cellKindOf } from "./studio-cells";
import { buildStudioRows } from "./studio-data";
import { opsCheck, opsEvent, opsRow, snapshotOf } from "./studio-fixtures";
import { STUDIO_FIELDS, STUDIO_RELATIONSHIPS, TABLE, buildStudioDataSources, isStudioFieldRef, type StudioTableId } from "./studio-model";

const deals = DEAL_STATUSES.map((status) => opsRow(status));
const rows = buildStudioRows(
  snapshotOf(
    deals,
    deals.map((deal) => opsCheck(deal)),
    deals.map((deal) => opsEvent(deal, "authorized")),
  ),
);
const model = buildStudioDataSources(rows);
const tables = Object.values(TABLE) as StudioTableId[];

describe("the Studio data model", () => {
  it("declares the four tables, in a stable order", () => {
    expect(model.sources.map((source) => source.id)).toEqual(["deals", "stages", "paymentEvents", "checks"]);
  });

  it("declares every column of every row, and no column that rows do not have", () => {
    for (const source of model.sources) {
      const declared = source.fields.map((field) => field.id).sort();
      expect(new Set(declared).size).toBe(declared.length);
      expect(source.data.length).toBeGreaterThan(0);
      for (const row of source.data) expect(Object.keys(row).sort()).toEqual(declared);
    }
  });

  it("gives every visible field a name and a description an agent can act on", () => {
    for (const table of tables) {
      for (const field of STUDIO_FIELDS[table]) {
        expect(field.name.length).toBeGreaterThan(0);
        if (field.hide) continue;
        expect(field.description?.length ?? 0, `${table}.${field.id}`).toBeGreaterThan(10);
        // Raw identifiers must never be what a person reads on an axis or a column header.
        expect(field.name, `${table}.${field.id}`).not.toMatch(/[_]|Usd$|Minor$/);
      }
    }
  });

  it("formats money as currency and rates as percentages", () => {
    for (const table of tables) {
      for (const field of STUDIO_FIELDS[table]) {
        if (field.id.endsWith("Usd")) expect(field, `${table}.${field.id}`).toMatchObject({ format: "currencyFormat", formatOptions: { format: "$#,##0.00" } });
      }
    }
    const byId = new Map(STUDIO_FIELDS.deals.map((field) => [field.id, field]));
    expect(byId.get("firstPass")?.format).toBe("percentageFormat");
    expect(byId.get("confidence")?.format).toBe("percentageFormat");
    expect(byId.get("createdAt")?.format).toBe("dateTimeFormat");
    expect(byId.get("day")?.format).toBe("dateFormat");
  });

  it("hides the join keys and relates every table to deals through them", () => {
    expect(STUDIO_RELATIONSHIPS.map((relation) => relation.source.tableId).sort()).toEqual(["checks", "paymentEvents", "stages"]);
    for (const relation of STUDIO_RELATIONSHIPS) {
      expect(relation.type).toBe("many-to-one");
      expect(relation.target).toEqual({ tableId: "deals", fieldId: "id" });
      const source = STUDIO_FIELDS[relation.source.tableId as StudioTableId].find((field) => field.id === relation.source.fieldId);
      expect(source?.hide).toBe(true);
    }
    expect(STUDIO_FIELDS.deals.find((field) => field.id === "id")?.hide).toBe(true);
  });

  it("joins every child row to a deal that exists", () => {
    const ids = new Set(rows.deals.map((row) => row.id));
    for (const row of [...rows.stages, ...rows.paymentEvents, ...rows.checks]) expect(ids.has(row.dealId)).toBe(true);
  });

  it("tags the columns the table widgets render specially with a known cell kind", () => {
    const tagged = tables.flatMap((table) => STUDIO_FIELDS[table].filter((field) => field.context !== undefined).map((field) => `${table}.${field.id}`));
    expect(tagged).toEqual(
      expect.arrayContaining(["deals.code", "deals.status", "deals.risk", "deals.paymentRail", "deals.verification", "checks.result", "checks.evaluator"]),
    );
    for (const table of tables) {
      for (const field of STUDIO_FIELDS[table]) if (field.context !== undefined) expect(cellKindOf(field.context)).not.toBeNull();
    }
  });

  it("copies rows and fields, so Studio never holds this module's arrays", () => {
    const again = buildStudioDataSources(rows);
    expect(again.sources[0]!.data).not.toBe(rows.deals);
    expect(again.sources[0]!.fields).not.toBe(model.sources[0]!.fields);
    expect(again.sources[0]!.data).toEqual(rows.deals);
  });
});

describe("isStudioFieldRef", () => {
  it("accepts table.field ids of the model only", () => {
    expect(isStudioFieldRef("deals.heldUsd")).toBe(true);
    expect(isStudioFieldRef("checks.failPercent")).toBe(true);
    expect(isStudioFieldRef("deals.nope")).toBe(false);
    expect(isStudioFieldRef("nope.id")).toBe(false);
    expect(isStudioFieldRef("heldUsd")).toBe(false);
    expect(isStudioFieldRef("constructor.name")).toBe(false);
  });
});
