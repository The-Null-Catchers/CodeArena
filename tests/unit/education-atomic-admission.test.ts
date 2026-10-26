import { describe, expect, it } from "vitest";
import { submissionSchema } from "../../packages/shared/src/domain.js";

const valid = {
  projectId: "00000000-0000-4000-8000-000000000001",
  language: "python",
  version: "3.13",
  source: "print(1)",
};
const attemptId = "00000000-0000-4000-8000-000000000002";
const challengeId = "00000000-0000-4000-8000-000000000003";

describe("education admission validation", () => {
  it("accepts a challenge-mode execution tied to a reserved attempt", () => {
    const input = submissionSchema.parse({
      ...valid, mode: "challenge", challengeId, educationAttemptId: attemptId,
    });
    expect(input.educationAttemptId).toBe(attemptId);
  });

  it("requires challenge mode and a challenge ID for education attempts", () => {
    expect(submissionSchema.safeParse({ ...valid, educationAttemptId: attemptId }).success).toBe(false);
    expect(submissionSchema.safeParse({
      ...valid, mode: "challenge", educationAttemptId: attemptId,
    }).success).toBe(false);
  });

  it("does not allow arbitrary values as attempt IDs", () => {
    expect(submissionSchema.safeParse({
      ...valid, mode: "challenge", challengeId, educationAttemptId: "other",
    }).success).toBe(false);
  });
});
