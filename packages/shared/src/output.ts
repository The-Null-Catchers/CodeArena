import { StringDecoder } from "node:string_decoder";
/** Caps raw and normalized UTF-8 bytes across all output channels. */
export class OutputBudget {
  private rawBytes = 0;
  private textBytes = 0;
  private readonly decoders = new Map<string, StringDecoder>();
  truncated = false;
  constructor(readonly maximumBytes: number) {}
  private bounded(text: string) {
    const encoded = Buffer.from(text);
    const remaining = Math.max(0, this.maximumBytes - this.textBytes);
    if (encoded.length > remaining) this.truncated = true;
    // StringDecoder.write avoids emitting an incomplete character at the byte boundary.
    const value = new StringDecoder("utf8").write(
      encoded.subarray(0, remaining),
    );
    this.textBytes += Buffer.byteLength(value);
    return value;
  }
  push(channel: string, chunk: Buffer) {
    const remaining = Math.max(0, this.maximumBytes - this.rawBytes);
    if (chunk.length > remaining) this.truncated = true;
    const part = chunk.subarray(0, remaining);
    this.rawBytes += part.length;
    let decoder = this.decoders.get(channel);
    if (!decoder) {
      decoder = new StringDecoder("utf8");
      this.decoders.set(channel, decoder);
    }
    return this.bounded(decoder.write(part));
  }
  finish(channel: string) {
    const decoder = this.decoders.get(channel);
    this.decoders.delete(channel);
    return decoder ? this.bounded(decoder.end()) : "";
  }
}
