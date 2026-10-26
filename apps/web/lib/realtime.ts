/** Browser-side SSE transport for bounded, replayable submission updates.
 * Redis stream IDs are replay cursors; a PostgreSQL snapshot is authoritative.
 */
export type StreamEvent = (event: string, data: any) => void;

export interface StreamOptions {
  fetcher?: typeof fetch;
  maxReconnects?: number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

class NonRetryableStreamError extends Error {}

const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]);

export function parseSseFrame(frame: string): { event: string; id?: string; data: any } | null {
  const data: string[] = [];
  let event = "message";
  let id: string | undefined;
  for (const raw of frame.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event" && value) event = value;
    else if (field === "id" && /^\d+-\d+$/.test(value)) id = value;
  }
  if (!data.length) return null;
  try {
    return { event, id, data: JSON.parse(data.join("\n")) };
  } catch {
    // A corrupt frame cannot be replayed safely; do not advance its cursor.
    return null;
  }
}

function isTerminal(data: unknown): boolean {
  return typeof data === "object" && data !== null &&
    "state" in data && terminal.has(String(data.state));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Resolves only after a terminal state or deliberate cancellation.
 * Unexpected EOF, 429, or temporary network failures use capped backoff.
 * Authorization failures and non-SSE responses fail immediately.
 */
export async function connectSubmissionStream(
  url: string,
  token: string,
  signal: AbortSignal,
  onEvent: StreamEvent,
  options: StreamOptions = {},
): Promise<void> {
  if (!token) throw new NonRetryableStreamError("Sign in required for live output");
  const fetcher = options.fetcher ?? fetch;
  const wait = options.wait ?? delay;
  const maxReconnects = options.maxReconnects ?? 6;
  let cursor: string | undefined;
  let reconnects = 0;

  while (!signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher(url, {
        signal,
        cache: "no-store",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
          ...(cursor ? { "Last-Event-ID": cursor } : {}),
        },
      });
      if ([400, 401, 403, 404, 405, 422].includes(response.status))
        throw new NonRetryableStreamError(`Execution stream unavailable (HTTP ${response.status})`);
      if (!response.ok) throw new Error(`Execution stream unavailable (HTTP ${response.status})`);
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body)
        throw new NonRetryableStreamError("Execution endpoint did not return an event stream");

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        // Flush a split UTF-8 character at EOF but do not dispatch incomplete frames.
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = parseSseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (!frame) continue;
          if (frame.id) cursor = frame.id;
          onEvent(frame.event, frame.data);
          if (isTerminal(frame.data) || signal.aborted) return;
        }
        if (buffer.length > 2 * 1024 * 1024)
          throw new NonRetryableStreamError("Execution event exceeded stream frame limit");
        if (done) break;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof NonRetryableStreamError) throw error;
      // A reader failure should not be confused with an execution failure.
    } finally {
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    if (signal.aborted) return;
    if (reconnects >= maxReconnects)
      throw new Error("Live execution updates disconnected. Check the persisted submission details.");
    reconnects += 1;
    await wait(Math.min(250 * 2 ** (reconnects - 1), 4000), signal);
  }
}
