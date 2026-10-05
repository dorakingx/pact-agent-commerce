import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonical";

describe("canonicalJson", () => {
  it("sorts object keys recursively and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("is independent of key insertion order", () => {
    const one = { price: { amountMinor: 4700, currency: "USD" }, deadline: "2026-10-07T18:00:00.000Z", rules: [{ id: "R1", required: true }] };
    const two = { rules: [{ required: true, id: "R1" }], deadline: "2026-10-07T18:00:00.000Z", price: { currency: "USD", amountMinor: 4700 } };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
    expect(sha256Hex(canonicalJson(one))).toBe(sha256Hex(canonicalJson(two)));
  });

  it("survives a JSON round trip unchanged", () => {
    const value = { b: [1, 2.5, -0, 1e21, 1e-7], a: "é\n\"quoted\" 日本語 😀", c: { nested: true, nothing: null } };
    const canonical = canonicalJson(value);
    expect(canonicalJson(JSON.parse(canonical))).toBe(canonical);
    expect(JSON.parse(canonical)).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2, 3])).toBe("[1,2,3]");
    expect(canonicalJson([3, 2, 1])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("serialises primitives like JSON", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(4700)).toBe("4700");
    expect(canonicalJson(0.85)).toBe("0.85");
    expect(canonicalJson("a\"b\\c")).toBe('"a\\"b\\\\c"');
    expect(canonicalJson("")).toBe('""');
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });

  it("sorts keys by UTF-16 code units, not by locale", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, "10": 4, "9": 5, é: 6 })).toBe('{"10":4,"9":5,"B":2,"a":3,"b":1,"é":6}');
  });

  it("distinguishes values that only differ in type", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson([])).not.toBe(canonicalJson({}));
  });

  it("accepts objects without a prototype", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.b = 2;
    bare.a = 1;
    expect(canonicalJson(bare)).toBe('{"a":1,"b":2}');
  });

  it("throws on undefined anywhere, instead of silently dropping it", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined at \$\.a/);
    expect(() => canonicalJson([1, undefined])).toThrow(/\$\[1\]/);
    // A hole in a sparse array must be treated like undefined, not skipped.
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    expect(() => canonicalJson(sparse)).toThrow(/\$\[1\]/);
  });

  it("throws on functions, symbols and BigInt", () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ s: Symbol("x") })).toThrow(/symbol/);
    expect(() => canonicalJson({ n: BigInt(10) })).toThrow(/bigint/);
  });

  it("throws on non-finite numbers", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalJson({ deep: [{ value: bad }] })).toThrow(/non-finite number at \$\.deep\[0\]\.value/);
    }
  });

  it("refuses Dates and other class instances: callers must pass ISO strings", () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/Date/);
    expect(() => canonicalJson(new Map([["a", 1]]))).toThrow(TypeError);
    expect(() => canonicalJson(new Set([1]))).toThrow(TypeError);
    expect(() => canonicalJson({ re: /x/ })).toThrow(TypeError);
    class Money {
      constructor(readonly minor: number) {}
    }
    expect(() => canonicalJson(new Money(1))).toThrow(TypeError);
  });

  it("throws on circular structures but allows repeated references", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(/circular/);

    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("does not mutate its input", () => {
    const input = { b: [3, 1, 2], a: { z: 1, y: 2 } };
    const before = JSON.stringify(input);
    canonicalJson(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.keys(input)).toEqual(["b", "a"]);
  });
});

describe("sha256Hex", () => {
  it("matches the published SHA-256 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes the UTF-8 encoding and returns 64 lowercase hex characters", () => {
    expect(sha256Hex("日本語")).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256Hex("é")).not.toBe(sha256Hex("e"));
  });

  it("is stable and sensitive to a single character", () => {
    const text = canonicalJson({ priceMinor: 4700 });
    expect(sha256Hex(text)).toBe(sha256Hex(text));
    expect(sha256Hex(text)).not.toBe(sha256Hex(canonicalJson({ priceMinor: 4701 })));
  });
});
