import { z } from "zod";
export const states = [
  "created",
  "queued",
  "scheduled",
  "preparing",
  "compiling",
  "running",
  "judging",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type State = (typeof states)[number];
export const terminal = new Set<State>([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
const edges: Record<State, State[]> = {
  created: ["queued", "cancelled"],
  queued: ["scheduled", "cancelled", "failed"],
  scheduled: ["preparing", "queued", "cancelled", "failed"],
  preparing: [
    "compiling",
    "running",
    "queued",
    "failed",
    "cancelled",
    "timed_out",
  ],
  compiling: [
    "running",
    "completed",
    "queued",
    "failed",
    "cancelled",
    "timed_out",
  ],
  running: [
    "judging",
    "completed",
    "queued",
    "failed",
    "cancelled",
    "timed_out",
  ],
  judging: ["completed", "queued", "failed", "cancelled", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};
export function canTransition(from: State, to: State) {
  return edges[from].includes(to);
}
export const limitSchema = z
  .object({
    cpuTimeMs: z.number().int().min(100).max(10000).default(2000),
    wallTimeMs: z.number().int().min(100).max(15000).default(5000),
    memoryMb: z.number().int().min(32).max(512).default(256),
    maxProcesses: z.number().int().min(1).max(64).default(32),
    maxOutputKb: z.number().int().min(1).max(1024).default(128),
    maxFileSizeKb: z.number().int().min(64).max(32768).default(10240),
  })
  .strict();
export type Limits = z.infer<typeof limitSchema>;
export const submissionSchema = z
  .object({
    projectId: z.string().uuid(),
    language: z.string().max(32),
    version: z.string().max(32),
    source: z.string().min(1).max(65536),
    stdin: z.string().max(65536).default(""),
    limits: limitSchema.default({}),
    priority: z.enum(["low", "normal", "high", "system"]).default("normal"),
    challengeId: z.string().uuid().optional(),
    mode: z.enum(["run", "challenge"]).default("run"),
  })
  .strict()
  .refine(
    (x) => x.mode !== "challenge" || !!x.challengeId,
    "Challenge ID required",
  );
export type Verdict =
  | "accepted"
  | "wrong_answer"
  | "runtime_error"
  | "compilation_error"
  | "time_limit_exceeded"
  | "memory_limit_exceeded"
  | "output_limit_exceeded"
  | "internal_error";
export type Judge = "exact" | "whitespace" | "case_insensitive" | "float";
export function judge(
  actual: string,
  expected: string,
  strategy: Judge,
  tolerance = 1e-6,
) {
  if (strategy === "exact") return actual === expected;
  if (strategy === "whitespace")
    return (
      actual.trim().replace(/\s+/g, " ") ===
      expected.trim().replace(/\s+/g, " ")
    );
  if (strategy === "case_insensitive")
    return actual.trim().toLowerCase() === expected.trim().toLowerCase();
  const a = actual.trim().split(/\s+/),
    e = expected.trim().split(/\s+/);
  return (
    a.length === e.length &&
    a.every((v, i) => {
      const x = Number(v),
        y = Number(e[i]);
      return (
        v !== "" &&
        e[i] !== "" &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Math.abs(x - y) <= tolerance * Math.max(1, Math.abs(y))
      );
    })
  );
}
export interface WorkerInfo {
  id: string;
  status: "online" | "busy" | "draining" | "offline" | "unhealthy";
  slots: number;
  active: number;
  runtimes: string[];
  lastHeartbeat: number;
}
export function selectWorker(
  workers: WorkerInfo[],
  runtime: string,
  now = Date.now(),
) {
  return workers
    .filter(
      (w) =>
        w.status === "online" &&
        now - w.lastHeartbeat < 15000 &&
        w.active < w.slots &&
        w.runtimes.includes(runtime),
    )
    .sort(
      (a, b) =>
        a.active / a.slots - b.active / b.slots || a.id.localeCompare(b.id),
    )[0];
}

export const priorityRank = { low: 0, normal: 1, high: 2, system: 3 } as const;
export function priorityAllowed(
  requested: keyof typeof priorityRank,
  allowed: keyof typeof priorityRank,
) {
  return priorityRank[requested] <= priorityRank[allowed];
}

export function quotaExceeded(
  usage: { outstanding: number; daily: number },
  plan: { maxOutstanding: number; maxDaily: number },
) {
  return (
    usage.outstanding >= plan.maxOutstanding || usage.daily >= plan.maxDaily
  );
}
export function roleCan(role: string, write: boolean) {
  return write
    ? ["owner", "admin", "developer"].includes(role)
    : ["owner", "admin", "developer", "viewer"].includes(role);
}
