import pg from "pg";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function audit(
  c: pg.PoolClient,
  action: string,
  userId: string | null,
  target: string,
) {
  await c.query(
    "INSERT INTO audit_logs(action,user_id,target) VALUES($1,$2,$3)",
    [action, userId, target],
  );
}
