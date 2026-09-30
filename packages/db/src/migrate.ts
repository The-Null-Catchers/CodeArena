import { readFile, readdir } from "node:fs/promises";
import { pool, tx } from "./index.js";
await tx(async (c) => {
  await c.query("SELECT pg_advisory_xact_lock(908301)");
  await c.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,created_at timestamptz DEFAULT now())",
  );
  for (const name of (await readdir("packages/db/migrations")).sort()) {
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]))
        .rowCount
    ) {
      await c.query(await readFile(`packages/db/migrations/${name}`, "utf8"));
      await c.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    }
  }
});
await pool.end();
