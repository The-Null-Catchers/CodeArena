import { afterEach, describe, expect, it, vi } from "vitest";
import { structuredLog } from "../../packages/shared/src/observability.js";

afterEach(() => vi.restoreAllMocks());

describe("structured service logs", () => {
  it("emits stable service/event/correlation fields", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => {});
    structuredLog("worker", {
      event: "submission.completed",
      correlationId: "req-123",
      submissionId: "submission-456",
      workerId: "worker-01",
    });
    const payload = JSON.parse(String(write.mock.calls[0][0]));
    expect(payload.service).toBe("worker");
    expect(payload.event).toBe("submission.completed");
    expect(payload.correlation_id).toBe("req-123");
    expect(payload.submissionId).toBe("submission-456");
    expect(payload.workerId).toBe("worker-01");
    expect(Date.parse(payload.timestamp)).not.toBeNaN();
  });

  it("falls back to submission identity when no request correlation is available", () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => {});
    structuredLog(
      "scheduler",
      { event: "recovery.failed", submissionId: "submission-456" },
      "error",
    );
    const payload = JSON.parse(String(write.mock.calls[0][0]));
    expect(payload.correlation_id).toBe("submission-456");
  });
});
