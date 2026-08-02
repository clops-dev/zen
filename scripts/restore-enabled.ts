import { sql } from "../src/lib/db"
await sql`UPDATE tier_routes SET enabled = true WHERE enabled = false`
const r = await sql`SELECT enabled, COUNT(*)::text AS n FROM tier_routes GROUP BY enabled ORDER BY enabled DESC`
for (const x of r) console.log(`${x.enabled} = ${x.n}`)
