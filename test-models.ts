import { sql } from './src/lib/db.ts';
const rows = await sql`SELECT m.model_id, m.label, p.name, p.provider_type, p.base_url FROM models m JOIN providers p ON m.provider_id = p.id`;
console.log(JSON.stringify(rows, null, 2));
process.exit(0);
