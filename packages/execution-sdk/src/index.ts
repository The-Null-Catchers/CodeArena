export interface SubmissionInput {
  projectId: string;
  language: string;
  version: string;
  source: string;
  stdin?: string;
  limits?: {
    wallTimeMs?: number;
    cpuTimeMs?: number;
    memoryMb?: number;
    maxProcesses?: number;
    maxOutputKb?: number;
    maxFileSizeKb?: number;
  };
  mode?: "run" | "challenge";
  challengeId?: string;
}
export class CodeArena {
  constructor(readonly config: { apiKey: string; baseUrl?: string }) {}
  async request(path: string, init: RequestInit = {}) {
    const r = await fetch(
      (this.config.baseUrl || "http://localhost:4000") + path,
      {
        ...init,
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${this.config.apiKey}`,
          ...init.headers,
        },
      },
    );
    const body = await r.json();
    if (!r.ok) throw new Error(body.error?.message || `HTTP ${r.status}`);
    return body;
  }
  submissions = {
    create: (input: SubmissionInput) =>
      this.request("/v1/submissions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    get: (id: string) => this.request(`/v1/submissions/${id}`),
    cancel: (id: string) =>
      this.request(`/v1/submissions/${id}/cancel`, { method: "POST" }),
    wait: async (
      id: string,
      options: { timeoutMs?: number; signal?: AbortSignal } = {},
    ) => {
      const signal = options.signal
        ? AbortSignal.any([
            options.signal,
            AbortSignal.timeout(options.timeoutMs || 120000),
          ])
        : AbortSignal.timeout(options.timeoutMs || 120000);
      const response = await fetch(
        (this.config.baseUrl || "http://localhost:4000") +
          `/v1/submissions/${id}/events`,
        { headers: { Authorization: `Bearer ${this.config.apiKey}` }, signal },
      );
      if (!response.ok || !response.body) throw new Error("STREAM_FAILED");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) throw new Error("STREAM_ENDED");
          buffer += decoder.decode(r.value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.split("\n").find((l) => l.startsWith("data: "));
            if (data) {
              const event = JSON.parse(data.slice(6));
              if (
                ["completed", "failed", "cancelled", "timed_out"].includes(
                  event.state,
                )
              )
                return this.request(`/v1/submissions/${id}`);
            }
          }
        }
      } finally {
        await reader.cancel();
      }
    },
  };
  runtimes = { list: () => this.request("/v1/runtimes") };
}
