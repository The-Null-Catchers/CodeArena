import { describe, expect, it } from "vitest";
import {
  applyOperation,
  applyTextChange,
  type AppliedOperation,
  type CollaborationOperation,
} from "../packages/shared/src/collaboration.js";

describe("interview collaboration adapter", () => {
  it("applies bounded text changes", () => {
    expect(
      applyTextChange("hello world", {
        index: 6,
        deleteCount: 5,
        insert: "CodeArena",
      }),
    ).toBe("hello CodeArena");
  });

  it("orders concurrent inserts deterministically", () => {
    const first: CollaborationOperation = {
      clientId: "client-a",
      sequence: 1,
      baseRevision: 0,
      change: { index: 0, deleteCount: 0, insert: "A" },
    };
    const appliedFirst = applyOperation("", first, [], 0);

    const second: CollaborationOperation = {
      clientId: "client-b",
      sequence: 1,
      baseRevision: 0,
      change: { index: 0, deleteCount: 0, insert: "B" },
    };
    const appliedSecond = applyOperation(
      appliedFirst.document,
      second,
      [appliedFirst.applied],
      1,
    );

    expect(appliedSecond.document).toBe("AB");
    expect(appliedSecond.applied.transformed.index).toBe(1);
  });

  it("rebases an insertion over an earlier insertion before its cursor", () => {
    const history: AppliedOperation[] = [
      {
        clientId: "alpha",
        sequence: 1,
        baseRevision: 0,
        revision: 1,
        change: { index: 1, deleteCount: 0, insert: "X" },
        transformed: { index: 1, deleteCount: 0, insert: "X" },
      },
    ];
    const operation: CollaborationOperation = {
      clientId: "beta",
      sequence: 1,
      baseRevision: 0,
      change: { index: 2, deleteCount: 0, insert: "Y" },
    };

    const result = applyOperation("aXbc", operation, history, 1);
    expect(result.document).toBe("aXbYc");
  });

  it("collapses overlapping concurrent deletes instead of deleting twice", () => {
    const history: AppliedOperation[] = [
      {
        clientId: "alpha",
        sequence: 1,
        baseRevision: 0,
        revision: 1,
        change: { index: 1, deleteCount: 2, insert: "" },
        transformed: { index: 1, deleteCount: 2, insert: "" },
      },
    ];
    const operation: CollaborationOperation = {
      clientId: "beta",
      sequence: 1,
      baseRevision: 0,
      change: { index: 2, deleteCount: 2, insert: "" },
    };

    const result = applyOperation("ade", operation, history, 1);
    expect(result.document).toBe("ae");
    expect(result.applied.transformed.deleteCount).toBe(1);
  });

  it("rejects revisions from the future", () => {
    expect(() =>
      applyOperation(
        "abc",
        {
          clientId: "client-a",
          sequence: 2,
          baseRevision: 4,
          change: { index: 1, deleteCount: 0, insert: "x" },
        },
        [],
        3,
      ),
    ).toThrow(/ahead/);
  });
});
