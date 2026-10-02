import { Redis } from "ioredis";
import type pg from "pg";
import { canTransition, terminal, type State } from "./domain.js";
export const redis = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: 1,
  commandTimeout: 1500,
  enableOfflineQueue: false,
  autoResendUnfulfilledCommands: false,
});
redis.on("error", () => {
  // Callers handle bounded command failures; reconnect attempts are expected during outages.
});
// BullMQ's blocking worker connection must keep retrying. Never use it for HTTP,
// event publication or cancellation: those operations must finish during an outage.
export function createWorkerConnection() {
  const connection = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,
  });
  connection.on("error", () => {});
  return connection;
}
export async function publish(id: string, type: string, data: unknown) {
  // PostgreSQL owns state and final output. Live events are best effort and are
  // reconciled from a fresh snapshot after reconnect, never an execution dependency.
  if (redis.status !== "ready") return false;
  try {
    // Publish and set retention atomically even if the server executes this
    // command after the caller's deadline. A delayed reply cannot leak a stream.
    await redis.eval(
      "local id=redis.call('XADD',KEYS[1],'MAXLEN','~',256,'*','type',ARGV[1],'data',ARGV[2]); redis.call('EXPIRE',KEYS[1],3600); return id",
      1,
      `events:${id}`,
      type,
      JSON.stringify(data),
    );
    return true;
  } catch {
    return false;
  }
}
export async function publishControlEvent(
  stream: string,
  type: string,
  data: unknown,
) {
  if (redis.status !== "ready") return false;
  try {
    await redis.eval(
      "local id=redis.call('XADD',KEYS[1],'MAXLEN','~',512,'*','type',ARGV[1],'data',ARGV[2]); redis.call('EXPIRE',KEYS[1],3600); return id",
      1,
      stream,
      type,
      JSON.stringify(data),
    );
    return true;
  } catch {
    return false;
  }
}

export const controlPlaneStream = "control:events";

export async function transition(
  c: pg.PoolClient,
  id: string,
  state: State,
  reason: string,
  workerId?: string,
  attempt?: number,
  metadata: unknown = {},
) {
  const row = (
    await c.query("SELECT * FROM submissions WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (!row || terminal.has(row.state)) return false;
  if (workerId && (row.worker_id !== workerId || row.attempt !== attempt))
    return false;
  if (!canTransition(row.state, state))
    throw new Error(`INVALID_TRANSITION:${row.state}:${state}`);
  await c.query(
    "INSERT INTO submission_events(submission_id,state,worker_id,reason,duration_ms,metadata) VALUES($1,$2,$3,$4,$5,$6)",
    [
      id,
      state,
      workerId || null,
      reason,
      Date.now() - new Date(row.updated_at).getTime(),
      JSON.stringify(metadata),
    ],
  );
  await c.query(
    "UPDATE submissions SET state=$2,updated_at=now() WHERE id=$1",
    [id, state],
  );
  const eventName = state === "running" ? "started" : state;
  if (terminal.has(state) || state === "queued" || state === "running") {
    const event = `submission.${eventName}`;
    await c.query(
      `INSERT INTO webhook_deliveries(endpoint_id,submission_id,event,payload) SELECT id,$1::uuid,$2::text,jsonb_build_object('event',$2::text,'submissionId',$1::uuid::text,'status',$3::text) FROM webhook_endpoints WHERE project_id=$4 AND enabled ON CONFLICT DO NOTHING`,
      [id, event, state, row.project_id],
    );
  }
  return true;
}
