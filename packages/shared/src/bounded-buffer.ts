/** Binary Docker stream collector with bounded bytes and bounded allocation overhead. */
export class BoundedBuffer {
  private storage = Buffer.alloc(0);
  private storedBytes = 0;
  truncated = false;

  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
      throw new Error("INVALID_BUFFER_LIMIT");
  }

  push(chunk: Buffer): boolean {
    const remaining = this.maximumBytes - this.storedBytes;
    const accepted = Math.min(remaining, chunk.length);
    if (accepted > 0) {
      const needed = this.storedBytes + accepted;
      if (needed > this.storage.length) {
        // Geometric growth prevents millions of tiny writes from retaining
        // millions of Buffer objects or causing quadratic concatenations.
        const capacity = Math.min(
          this.maximumBytes,
          Math.max(needed, this.storage.length === 0 ? 256 : this.storage.length * 2),
        );
        const next = Buffer.allocUnsafe(capacity);
        this.storage.copy(next, 0, 0, this.storedBytes);
        this.storage = next;
      }
      chunk.copy(this.storage, this.storedBytes, 0, accepted);
      this.storedBytes = needed;
    }
    if (accepted < chunk.length) this.truncated = true;
    return !this.truncated;
  }

  toBuffer() {
    // Return a copy, never an alias to the collector's mutable capacity.
    return Buffer.from(this.storage.subarray(0, this.storedBytes));
  }

  get byteLength() {
    return this.storedBytes;
  }
}
