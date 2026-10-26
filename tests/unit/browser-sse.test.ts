import { describe, it, expect } from "vitest";
import { connectSubmissionStream, parseSseFrame } from "../../apps/web/lib/realtime";

const encoder = new TextEncoder();
function sse(...chunks: string[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

describe("browser execution SSE transport", () => {
  it("parses multiline SSE and ignores comment/invalid frames", () => {
    expect(parseSseFrame(': keepalive')).toBeNull();
    expect(parseSseFrame('event: state\nid: 1-2\ndata: {"state":\ndata: "running"}')).toEqual({
      event: "state", id: "1-2", data: { state: "running" },
    });
    expect(parseSseFrame('event: state\nid: bad-id\ndata: not-json')).toBeNull();
  });

  it("replays from the last complete event ID after a dropped connection", async () => {
    const seen: Array<[string, any]> = [];
    const cursors: string[] = [];
    const responses = [
      sse('event: snapshot\ndata: {"state":"running"}\n\n',
        'id: 7-0\nevent: output\ndata: {"kind":"stdout","text":"Hel'),
      sse('event: snapshot\ndata: {"state":"running"}\n\n',
        'id: 7-0\nevent: output\ndata: {"kind":"stdout","text":"Hello"}\n\n'),
      sse('event: snapshot\ndata: {"state":"completed"}\n\n'),
    ];
    const mock = (async (_url: string, init?: RequestInit) => {
      cursors.push(new Headers(init?.headers).get("Last-Event-ID") || "");
      return responses.shift()!;
    }) as typeof fetch;
    await connectSubmissionStream("http://localhost/events", "token",
      new AbortController().signal, (event, data) => seen.push([event, data]), {
        fetcher: mock, maxReconnects: 2, wait: async () => {},
      });
    expect(cursors).toEqual(["", "", "7-0"]);
    expect(seen.filter(([event]) => event === "output").map(([, data]) => data.text)).toEqual(["Hello"]);
    expect(seen.at(-1)?.[1].state).toBe("completed");
  });

  it("does not reconnect on authorization failure", async () => {
    let count = 0;
    const mock = (async () => {
      count += 1;
      return new Response("", { status: 401 });
    }) as typeof fetch;
    await expect(connectSubmissionStream("http://localhost/events", "token",
      new AbortController().signal, () => {}, { fetcher: mock })).rejects.toThrow("401");
    expect(count).toBe(1);
  });

  it("bounds disconnect retries without fabricating execution failure", async () => {
    let count = 0;
    const mock = (async () => { count += 1; return sse(": heartbeat\n\n"); }) as typeof fetch;
    await expect(connectSubmissionStream("http://localhost/events", "token",
      new AbortController().signal, () => {}, {
        fetcher: mock, maxReconnects: 2, wait: async () => {},
      })).rejects.toThrow("persisted submission details");
    expect(count).toBe(3);
  });

  it("stops reconnecting after an abort", async () => {
    const controller = new AbortController();
    let count = 0;
    const mock = (async () => { count += 1; return sse('event: snapshot\ndata: {"state":"queued"}\n\n'); }) as typeof fetch;
    await connectSubmissionStream("http://localhost/events", "token",
      controller.signal, () => { controller.abort(); }, {
        fetcher: mock, wait: async () => {},
      });
    expect(count).toBe(1);
  });

  it("keeps UTF-8 and CRLF frames intact across chunk boundaries", async () => {
    const seen: any[] = [];
    const mock = (async () => sse(
      'id: 8-1\r\nevent: output\r\ndata: {"text":"caf',
      'é"}\r', '\n\r\n',
      'event: snapshot\r\ndata: {"state":"completed"}\r\n\r\n',
    )) as typeof fetch;
    await connectSubmissionStream("http://localhost/events", "token",
      new AbortController().signal, (_event, data) => seen.push(data),
      { fetcher: mock, maxReconnects: 0 });
    expect(seen[0].text).toBe("café");
    expect(seen[1].state).toBe("completed");
  });
});
