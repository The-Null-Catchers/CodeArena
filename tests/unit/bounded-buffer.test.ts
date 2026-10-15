import { describe, expect, it } from "vitest";
import { BoundedBuffer } from "../../packages/shared/src/bounded-buffer.js";

describe("bounded Docker binary collection", () => {
  it("retains only the permitted prefix regardless of incoming chunk size", () => {
    const collector = new BoundedBuffer(5);
    expect(collector.push(Buffer.from("abc"))).toBe(true);
    expect(collector.push(Buffer.from("defgh"))).toBe(false);
    expect(collector.toBuffer().toString()).toBe("abcde");
    expect(collector.byteLength).toBe(5);
    expect(collector.truncated).toBe(true);
  });

  it("does not grow after exhausting the budget", () => {
    const collector = new BoundedBuffer(4);
    for (let i = 0; i < 1000; i++) collector.push(Buffer.alloc(1024));
    expect(collector.byteLength).toBe(4);
    expect(collector.toBuffer()).toEqual(Buffer.alloc(4));
  });

  it("copies input bytes so callers cannot mutate retained data", () => {
    const collector = new BoundedBuffer(10);
    const source = Buffer.from("secret");
    collector.push(source);
    source.fill(0);
    expect(collector.toBuffer().toString()).toBe("secret");
  });

  it("handles exact limits, zero budgets and rejects invalid bounds", () => {
    const exact = new BoundedBuffer(3);
    expect(exact.push(Buffer.from("abc"))).toBe(true);
    expect(exact.truncated).toBe(false);
    const empty = new BoundedBuffer(0);
    expect(empty.push(Buffer.from("x"))).toBe(false);
    expect(empty.byteLength).toBe(0);
    expect(() => new BoundedBuffer(-1)).toThrow("INVALID_BUFFER_LIMIT");
  });
});
