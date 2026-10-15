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
  it("keeps dispatching when the diagnostic reporter throws", async () => {
    const dispatched: string[] = [];
    const result = await dispatchIndependently(
      ["broken", "healthy"],
      async (id) => {
        if (id === "broken") throw new Error("BROKER_DOWN");
        dispatched.push(id);
      },
      () => {
        throw new Error("LOGGER_DOWN");
      },
    );
    expect(dispatched).toEqual(["healthy"]);
    expect(result).toEqual({ succeeded: 1, failed: 1 });
  });

  it("keeps dispatching after an asynchronous diagnostic rejection", async () => {
    const dispatched: number[] = [];
    const result = await dispatchIndependently(
      [1, 2, 3],
      async (id) => {
        if (id === 1 || id === 2) throw new Error("QUEUE_UNAVAILABLE");
        dispatched.push(id);
      },
      async () => {
        await Promise.resolve();
        throw new Error("REMOTE_LOGGER_UNAVAILABLE");
      },
    );
    expect(dispatched).toEqual([3]);
    expect(result).toEqual({ succeeded: 1, failed: 2 });
  });

  it("reports partial dispatch failures to support degraded readiness", async () => {
    const attempted: string[] = [];
    const result = await dispatchIndependently(
      ["worker-offline", "worker-online"],
      async (id) => {
        attempted.push(id);
        if (id === "worker-offline") throw new Error("REDIS_QUEUE_UNAVAILABLE");
      },
      () => {},
    );
    expect(attempted).toEqual(["worker-offline", "worker-online"]);
    expect(result).toEqual({ succeeded: 1, failed: 1 });
  });

});
