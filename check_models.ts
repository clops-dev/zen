import { runMigrations } from "./src/lib/migrate.ts";
import { sql } from "./src/lib/db.ts";

async function run() {
  await runMigrations();
  const models = await sql`SELECT id, label, model_id, supports_tools, supports_vision, supports_json_mode FROM models`;
  console.table(models);
  process.exit(0);
}

run();
