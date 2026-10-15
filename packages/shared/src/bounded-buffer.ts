/** Bounded binary collector for trusted-worker Docker stream handling. */
export class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
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
      this.chunks.push(Buffer.from(chunk.subarray(0, accepted)));
      this.storedBytes += accepted;
    }
    if (accepted < chunk.length) this.truncated = true;
    return !this.truncated;
  }
  toBuffer() {
    return Buffer.concat(this.chunks, this.storedBytes);
  }
  get byteLength() {
    return this.storedBytes;
  }
}
