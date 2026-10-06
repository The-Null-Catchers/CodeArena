export type TextChange = {
  index: number;
  deleteCount: number;
  insert: string;
};

export type CollaborationOperation = {
  clientId: string;
  sequence: number;
  baseRevision: number;
  change: TextChange;
};

export type AppliedOperation = CollaborationOperation & {
  revision: number;
  transformed: TextChange;
};

export function validateChange(document: string, change: TextChange) {
  if (!Number.isInteger(change.index) || change.index < 0)
    throw new Error("change.index must be a non-negative integer");
  if (!Number.isInteger(change.deleteCount) || change.deleteCount < 0)
    throw new Error("change.deleteCount must be a non-negative integer");
  if (change.index > document.length)
    throw new Error("change.index is outside the document");
  if (change.index + change.deleteCount > document.length)
    throw new Error("change deletion extends past the document");
}

export function applyTextChange(document: string, change: TextChange) {
  validateChange(document, change);
  return (
    document.slice(0, change.index) +
    change.insert +
    document.slice(change.index + change.deleteCount)
  );
}

function compareOperationIdentity(
  left: Pick<CollaborationOperation, "clientId" | "sequence">,
  right: Pick<CollaborationOperation, "clientId" | "sequence">,
) {
  const client = left.clientId.localeCompare(right.clientId);
  return client || left.sequence - right.sequence;
}

/**
 * Rebase one splice over an already-applied concurrent splice.
 *
 * This intentionally keeps the wire/storage format engine-neutral. A future CRDT
 * implementation can consume the same immutable operation identities while the
 * current text adapter provides deterministic convergence for plain-text editors.
 */
export function transformChange(
  incoming: CollaborationOperation,
  applied: AppliedOperation,
): TextChange {
  const next = { ...incoming.change };
  const prior = applied.transformed;
  const priorStart = prior.index;
  const priorEnd = prior.index + prior.deleteCount;
  const delta = prior.insert.length - prior.deleteCount;
  const incomingStart = next.index;
  const incomingEnd = next.index + next.deleteCount;

  if (priorEnd < incomingStart) {
    next.index += delta;
    return next;
  }

  if (priorEnd === incomingStart) {
    if (
      prior.deleteCount > 0 ||
      compareOperationIdentity(applied, incoming) <= 0
    )
      next.index += delta;
    return next;
  }

  if (priorStart > incomingEnd) return next;

  if (priorStart === incomingEnd && incoming.deleteCount === 0) return next;

  if (
    priorStart === incomingStart &&
    prior.deleteCount === 0 &&
    incoming.change.deleteCount === 0
  ) {
    if (compareOperationIdentity(applied, incoming) <= 0)
      next.index += prior.insert.length;
    return next;
  }

  // Overlapping deletes collapse onto the surviving range. Insertions from the
  // already-applied operation stay intact; only text that still exists is removed.
  const overlapStart = Math.max(incomingStart, priorStart);
  const overlapEnd = Math.min(incomingEnd, priorEnd);
  const removedByPrior = Math.max(0, overlapEnd - overlapStart);

  if (priorStart < incomingStart) next.index = priorStart + prior.insert.length;
  if (priorStart < incomingStart) next.index += Math.max(0, incomingStart - priorEnd);

  next.deleteCount = Math.max(0, next.deleteCount - removedByPrior);
  if (priorEnd <= incomingStart) next.index += delta;
  return next;
}

export function rebaseOperation(
  operation: CollaborationOperation,
  history: AppliedOperation[],
) {
  let transformed = { ...operation.change };
  let working: CollaborationOperation = { ...operation, change: transformed };
  for (const applied of history) {
    if (applied.revision <= operation.baseRevision) continue;
    transformed = transformChange(working, applied);
    working = { ...working, change: transformed };
  }
  return transformed;
}

export function applyOperation(
  document: string,
  operation: CollaborationOperation,
  history: AppliedOperation[],
  revision: number,
) {
  if (!operation.clientId || operation.clientId.length > 80)
    throw new Error("clientId must be between 1 and 80 characters");
  if (!Number.isInteger(operation.sequence) || operation.sequence < 0)
    throw new Error("sequence must be a non-negative integer");
  if (!Number.isInteger(operation.baseRevision) || operation.baseRevision < 0)
    throw new Error("baseRevision must be a non-negative integer");
  if (operation.baseRevision > revision)
    throw new Error("baseRevision is ahead of the current revision");

  const transformed = rebaseOperation(operation, history);
  const nextDocument = applyTextChange(document, transformed);
  return {
    document: nextDocument,
    revision: revision + 1,
    applied: {
      ...operation,
      revision: revision + 1,
      transformed,
    } satisfies AppliedOperation,
  };
}
