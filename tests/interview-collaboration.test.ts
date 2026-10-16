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

  it("converges on identical text regardless of concurrent insert arrival order", () => {
    const a: CollaborationOperation = {
      clientId: "client-a",
      sequence: 1,
      baseRevision: 0,
      change: { index: 0, deleteCount: 0, insert: "A" },
    };
    const b: CollaborationOperation = {
      clientId: "client-b",
      sequence: 1,
      baseRevision: 0,
      change: { index: 0, deleteCount: 0, insert: "B" },
    };
    const aFirst = applyOperation("", a, [], 0);
    const ab = applyOperation(aFirst.document, b, [aFirst.applied], 1);
    const bFirst = applyOperation("", b, [], 0);
    const ba = applyOperation(bFirst.document, a, [bFirst.applied], 1);

    expect(ab.document).toBe("AB");
    expect(ba.document).toBe(ab.document);
    expect(ab.revision).toBe(2);
    expect(ba.revision).toBe(2);
  });

  it("converges for three simultaneous inserts across all arrival permutations", () => {
    const operations: CollaborationOperation[] = ["client-a", "client-b", "client-c"].map(
      (clientId, index) => ({
        clientId,
        sequence: 1,
        baseRevision: 0,
        change: { index: 0, deleteCount: 0, insert: String.fromCharCode(65 + index) },
      }),
    );
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2],
      [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    for (const order of permutations) {
      let document = "";
      const history: AppliedOperation[] = [];
      for (const index of order) {
        const next = applyOperation(document, operations[index], history, history.length);
        document = next.document;
        history.push(next.applied);
      }
      expect(document).toBe("ABC");
      expect(history.map((entry) => entry.revision)).toEqual([1, 2, 3]);
    }
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
