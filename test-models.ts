import { sql } from './src/lib/db.ts';
const rows = await sql`SELECT m.model_id, m.label, p.name, p.base_url FROM models m JOIN providers p ON m.provider_id = p.id`;
console.log(JSON.stringify(rows.map((r: any) => ({ model_id: r.model_id, label: r.label, provider: r.name, base_url: r.base_url })), null, 2));
process.exit(0);
