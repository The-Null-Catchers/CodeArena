import { describe, it, expect } from "vitest";
import {
  getRuntime,
  runtimeImage,
  snapshotRuntime,
} from "../../packages/shared/src/runtimes.js";
const imageId = `sha256:${"a".repeat(64)}`;
describe("runtime image snapshots", () => {
  it("refuses mutable tags as snapshot identities", () => {
    expect(() =>
      snapshotRuntime(getRuntime("python", "3.13"), "python:latest"),
    ).toThrow("IMMUTABLE_RUNTIME_IMAGE_REQUIRED");
  });
  it("retains its image despite deployment override changes", () => {
    const previous = process.env.RUNTIME_IMAGE_PYTHON;
    try {
      const captured = snapshotRuntime(getRuntime("python", "3.13"), imageId);
      process.env.RUNTIME_IMAGE_PYTHON = "some-new-image:latest";
      expect(runtimeImage(captured)).toBe(imageId);
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_IMAGE_PYTHON;
      else process.env.RUNTIME_IMAGE_PYTHON = previous;
    }
  });
  it("captures independent commands and environment arrays", () => {
    const original = getRuntime("python", "3.13");
    const captured = snapshotRuntime(original, imageId);
    captured.execute.push("extra");
    captured.environment.push("TEST=1");
    expect(original.execute).not.toContain("extra");
    expect(original.environment).not.toContain("TEST=1");
  });
});
