import express from 'express';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import pg from 'pg';

const app = express();
app.use(express.json());

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme-admin-token';
const BACKEND = (process.env.CATALOG_BACKEND || 'file').toLowerCase();
const DATA_PATH = process.env.CATALOG_PATH || '/data/custom_tokens.json';
const DATABASE_URL = process.env.DATABASE_URL;
const { Pool } = pg;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

function requireAdmin(req,res,next){
  // In prod this should be protected by OIDC proxy; bearer is fallback for local.
  const auth = req.headers['authorization'] || '';
  if(!auth.startsWith('Bearer ')) return res.status(401).json({error:'UNAUTHORIZED'});
  if(auth.slice(7) !== ADMIN_TOKEN) return res.status(403).json({error:'FORBIDDEN'});
  next();
}

function readFileDB(){
  try{ return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')); } catch(e){ return { tokens: [], version:'1.0.0' }; }
}
function writeFileDB(db){ fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2)); }

// ---- Admin create ----
app.post('/catalog/admin/tokens', requireAdmin, async (req,res)=>{
  const { name, symbol, network, priceFiat, fiatCurrency, inventory, decimals=18, contractAddress=null, logoUrl='' } = req.body;
  if(!name||!symbol||!network||priceFiat==null||!fiatCurrency||inventory==null) return res.status(400).json({error:'MISSING_FIELDS'});
  const id = uuid();
  if (BACKEND==='postgres' && pool){
    const client = await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query(`INSERT INTO custom_tokens (id,name,symbol,network,price_fiat,fiat_currency,decimals,contract_address,logo_url,enabled,inventory,reserved) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,0)`,
        [id,name,symbol,network,priceFiat,fiatCurrency,decimals,contractAddress,logoUrl,inventory]);
      await client.query('COMMIT');
      res.status(201).json({ id, name, symbol, network, priceFiat, fiatCurrency, decimals, contractAddress, logoUrl, enabled:true, inventory, reserved:0 });
    } catch(e){ await client.query('ROLLBACK'); res.status(500).json({error:'DB_ERROR', message:e.message}); } finally { client.release(); }
  } else {
    const db = readFileDB(); db.tokens.push({ id,name,symbol,network,priceFiat,fiatCurrency,decimals,contractAddress,logoUrl,enabled:true,inventory,reserved:0,holds:[] });
    writeFileDB(db); res.status(201).json(db.tokens.at(-1));
  }
});

// ---- Admin patch ----
app.patch('/catalog/admin/tokens/:id', requireAdmin, async (req,res)=>{
  const { priceFiat, fiatCurrency, inventory, enabled, logoUrl } = req.body;
  if (BACKEND==='postgres' && pool){
    const client = await pool.connect();
    try{
      const fields=[]; const vals=[]; let i=1;
      if(priceFiat!=null){ fields.push(`price_fiat=$${i++}`); vals.push(priceFiat); }
      if(fiatCurrency!=null){ fields.push(`fiat_currency=$${i++}`); vals.push(fiatCurrency); }
      if(inventory!=null){ fields.push(`inventory=$${i++}`); vals.push(inventory); }
      if(enabled!=null){ fields.push(`enabled=$${i++}`); vals.push(!!enabled); }
      if(logoUrl!=null){ fields.push(`logo_url=$${i++}`); vals.push(logoUrl); }
      vals.push(req.params.id);
      const { rows } = await client.query(`UPDATE custom_tokens SET ${fields.join(',')}, updated_at=now() WHERE id=$${i} RETURNING *`, vals);
      if(!rows.length) return res.status(404).json({error:'NOT_FOUND'});
      const t = rows[0];
      res.json({ id:t.id, name:t.name, symbol:t.symbol, network:t.network, priceFiat:t.price_fiat, fiatCurrency:t.fiat_currency, decimals:t.decimals, contractAddress:t.contract_address, logoUrl:t.logo_url, enabled:t.enabled, inventory:t.inventory, reserved:t.reserved });
    } finally { client.release(); }
  } else {
    const db = readFileDB(); const t = db.tokens.find(x=>x.id===req.params.id); if(!t) return res.status(404).json({error:'NOT_FOUND'});
    if(priceFiat!=null) t.priceFiat = Number(priceFiat);
    if(fiatCurrency!=null) t.fiatCurrency = fiatCurrency;
    if(inventory!=null) t.inventory = Number(inventory);
    if(enabled!=null) t.enabled = !!enabled;
    if(logoUrl!=null) t.logoUrl = logoUrl;
    writeFileDB(db); res.json(t);
  }
});

// ---- Public list ----
app.get('/catalog/public/custom-tokens', async (req,res)=>{
  const { network, search } = req.query;
  if (BACKEND==='postgres' && pool){
    const client = await pool.connect();
    try{
      let q = 'SELECT * FROM custom_tokens WHERE enabled=true'; const vals=[];
      if(network){ vals.push(String(network).toLowerCase()); q += ` AND lower(network)=$${vals.length}`; }
      if(search){ vals.push('%'+String(search).lower()+'%'); q += f" AND (lower(symbol) LIKE ${{len(vals)}} OR lower(name) LIKE ${{len(vals)}})"; }
      const { rows } = await client.query(q, vals);
      const tokens = rows.map(t => ({ id:t.id, name:t.name, symbol:t.symbol, network:t.network, priceFiat:t.price_fiat, fiatCurrency:t.fiat_currency, decimals:t.decimals, contractAddress:t.contract_address, logoUrl:t.logo_url, enabled:t.enabled, inventory:t.inventory, reserved:t.reserved, available: (t.inventory - t.reserved) }));
      res.json({ tokens });
    } finally { client.release(); }
  } else {
    const db = readFileDB();
    let list = db.tokens.filter(t=>t.enabled);
    if(network) list = list.filter(t => t.network.toLowerCase() === String(network).toLowerCase());
    if(search){ const s = String(search).toLowerCase(); list = list.filter(t => t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s)); }
    list = list.map(t => ({ ...t, available: Math.max(0, t.inventory - t.reserved) }));
    res.json({ tokens: list });
  }
});

// ---- Internal reserve/commit/release with DB locks ----
app.post('/catalog/internal/reserve', async (req,res)=>{
  const { tokenId, amountCrypto } = req.body || {}; const amt = Number(amountCrypto||0);
  if (BACKEND!=='postgres' || !pool) return res.status(501).json({error:'USE_POSTGRES_FOR_RESERVATIONS'});
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    const { rows:[t] } = await client.query('SELECT * FROM custom_tokens WHERE id=$1 FOR UPDATE', [tokenId]);
    if(!t) { await client.query('ROLLBACK'); return res.status(404).json({error:'TOKEN_NOT_FOUND'}); }
    const available = Number(t.inventory) - Number(t.reserved);
    if(amt <= 0 || amt > available){ await client.query('ROLLBACK'); return res.status(409).json({error:'INSUFFICIENT_INVENTORY', available}); }
    const holdId = uuid();
    await client.query('INSERT INTO reservations(hold_id, token_id, amount, expiry) VALUES($1,$2,$3, now()+ interval '10 minutes')', [holdId, tokenId, amt]);
    await client.query('UPDATE custom_tokens SET reserved = reserved + $1, updated_at=now() WHERE id=$2', [amt, tokenId]);
    await client.query('COMMIT');
    res.status(201).json({ holdId, priceFiat: t.price_fiat, fiatCurrency: t.fiat_currency, token: { id: t.id, symbol: t.symbol, network: t.network, name: t.name, decimals: t.decimals } });
  } catch(e){ await client.query('ROLLBACK'); res.status(500).json({error:'DB_ERROR', message:e.message}); } finally { client.release(); }
});

app.post('/catalog/internal/commit', async (req,res)=>{
  const { tokenId, holdId } = req.body || {};
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    const { rows:[h] } = await client.query('SELECT * FROM reservations WHERE hold_id=$1', [holdId]);
    if(!h) { await client.query('ROLLBACK'); return res.status(404).json({error:'HOLD_NOT_FOUND'}); }
    if(h.token_id !== tokenId) { await client.query('ROLLBACK'); return res.status(400).json({error:'TOKEN_MISMATCH'}); }
    await client.query('SELECT 1 FROM custom_tokens WHERE id=$1 FOR UPDATE', [tokenId]);
    await client.query('UPDATE custom_tokens SET inventory = inventory - $1, reserved = reserved - $1, updated_at=now() WHERE id=$2', [h.amount, tokenId]);
    await client.query('DELETE FROM reservations WHERE hold_id=$1', [holdId]);
    await client.query('COMMIT'); res.json({ ok:true });
  } catch(e){ await client.query('ROLLBACK'); res.status(500).json({error:'DB_ERROR', message:e.message}); } finally { client.release(); }
});

app.post('/catalog/internal/release', async (req,res)=>{
  const { tokenId, holdId } = req.body || {}; const client = await pool.connect();
  try{
    await client.query('BEGIN');
    const { rows:[h] } = await client.query('SELECT * FROM reservations WHERE hold_id=$1', [holdId]);
    if(!h) { await client.query('ROLLBACK'); return res.status(404).json({error:'HOLD_NOT_FOUND'}); }
    await client.query('SELECT 1 FROM custom_tokens WHERE id=$1 FOR UPDATE', [tokenId]);
    await client.query('UPDATE custom_tokens SET reserved = reserved - $1, updated_at=now() WHERE id=$2', [h.amount, tokenId]);
    await client.query('DELETE FROM reservations WHERE hold_id=$1', [holdId]);
    await client.query('COMMIT'); res.json({ ok:true });
  } catch(e){ await client.query('ROLLBACK'); res.status(500).json({error:'DB_ERROR', message:e.message}); } finally { client.release(); }
});

app.listen(3000, ()=>console.log('catalog on 3000'));
