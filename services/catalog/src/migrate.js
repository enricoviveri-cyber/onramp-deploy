import fs from 'fs';
import pg from 'pg';
const { Client } = pg;
const sql = fs.readFileSync('/app/src/sql/001_init.sql','utf-8');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const c = new Client({ connectionString:url });
const run = async () => { await c.connect(); await c.query(sql); await c.end(); console.log('migrations applied'); };
run().catch(e=>{ console.error(e); process.exit(1); });
