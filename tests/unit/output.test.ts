import { describe, expect, it } from "vitest";
import { OutputBudget } from "../../packages/shared/src/output.js";
describe("bounded streaming output", () => {
  it("preserves characters split across stream chunks", () => {
    const b = new OutputBudget(100),
      data = Buffer.from("مرحبا");
    const text =
      b.push("stdout", data.subarray(0, 1)) +
      b.push("stdout", data.subarray(1)) +
      b.finish("stdout");
    expect(text).toBe("مرحبا");
    expect(b.truncated).toBe(false);
  });
  it("caps combined channels and refuses infinite output growth", () => {
    const b = new OutputBudget(4);
    expect(b.push("stdout", Buffer.from("ab"))).toBe("ab");
    expect(b.push("stderr", Buffer.from("cdef"))).toBe("cd");
    for (let i = 0; i < 100; i++)
      expect(b.push("stdout", Buffer.alloc(4096))).toBe("");
    expect(b.truncated).toBe(true);
  });
  it("caps expansion caused by malformed UTF-8", () => {
    const b = new OutputBudget(4);
    const text =
      b.push("stdout", Buffer.from([255, 255, 255, 255])) + b.finish("stdout");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4);
    expect(b.truncated).toBe(true);
  });
});
