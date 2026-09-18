import { sql } from '../src/lib/db.ts';

async function main() {
  await sql`
    UPDATE models 
    SET context_window = 128000 
    WHERE model_id IN ('gpt-5.1', 'gpt-4.1-mini')
  `;
  const rows = await sql`SELECT id, model_id, context_window FROM models`;
  console.table(rows);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
