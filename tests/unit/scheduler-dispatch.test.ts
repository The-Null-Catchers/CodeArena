import { describe, expect, it, vi } from "vitest";
import { dispatchIndependently } from "../../apps/scheduler/src/dispatch.js";

describe("durable outbox fault isolation", () => {
  it("continues with healthy entries after a failed worker dispatch", async () => {
    const processed: number[] = [];
    const errors: number[] = [];
    const result = await dispatchIndependently(
      [1, 2, 3, 4],
      async (id) => {
        if (id === 2) throw new Error("REDIS_DISCONNECTED");
        processed.push(id);
      },
      (id) => errors.push(id),
    );
    expect(processed).toEqual([1, 3, 4]);
    expect(errors).toEqual([2]);
    expect(result).toEqual({ succeeded: 3, failed: 1 });
  });

  it("does not report success for failed entries or attempt them twice", async () => {
    const dispatch = vi.fn(async (id: string) => {
      if (id === "lost") throw new Error("QUEUE_ADD_FAILED");
    });
    const failures: string[] = [];
    const result = await dispatchIndependently(
      ["lost", "healthy"],
      dispatch,
      (id) => failures.push(id),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(failures).toEqual(["lost"]);
    expect(result).toEqual({ succeeded: 1, failed: 1 });
  });
});
