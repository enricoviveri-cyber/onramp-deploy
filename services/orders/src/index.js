import express from 'express';
import axios from 'axios';
import { v4 as uuid } from 'uuid';
import pg from 'pg';
import Stripe from 'stripe';
import { audit } from '../../shared/audit.js';

const app = express();
app.use(express.json({verify:(req,res,buf)=>{ req.rawBody = buf; }}));
app.use(audit);

const stripe = process.env.STRIPE_SECRET ? new Stripe(process.env.STRIPE_SECRET) : null;
const ORDERS = {};
const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

async function withIdempotency(key, handler){
  if(!key || !pool) return handler();
  const c = await pool.connect();
  try{
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT response FROM idempotency_keys WHERE key=$1', [key]);
    if(rows.length){ await c.query('COMMIT'); return rows[0].response; }
    const resp = await handler();
    await c.query('INSERT INTO idempotency_keys(key,response) VALUES($1,$2)', [key, resp]);
    await c.query('COMMIT');
    return resp;
  } catch(e){ await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// Legacy quote/kyc flow (still available)
app.post('/orders', async (req, res) => {
  const id = uuid();
  const { fiatCurrency, cryptoCurrency, fiatAmount, paymentMethod, destAddress, network } = req.body;
  ORDERS[id] = { id, status: 'CREATED', fiatCurrency, cryptoCurrency, fiatAmount, paymentMethod, destAddress, network };
  const q = await axios.get(process.env.QUOTES_URL + '/quote', { params: { fiatAmount, fiatCurrency, cryptoCurrency } });
  ORDERS[id].quote = q.data;
  res.status(201).json(ORDERS[id]);
});

app.get('/orders/:id', (req, res) => {
  const o = ORDERS[req.params.id];
  if (!o) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(o);
});

// Custom token sell (uses catalog reservations)
app.post('/sell-orders', async (req, res) => {
  const idem = req.headers['idempotency-key'];
  try{
    const result = await withIdempotency(idem, async ()=>{
      const { tokenId, amountCrypto, method='CARD', destAddress } = req.body;
      if(!tokenId || !amountCrypto || !method || !destAddress) throw { status:400, data:{error:'MISSING_FIELDS'} };
      const r = await axios.post(process.env.CATALOG_URL + '/catalog/internal/reserve', { tokenId, amountCrypto });
      const { holdId, priceFiat, fiatCurrency, token } = r.data;
      const id = uuid(); const totalFiat = +(Number(priceFiat) * Number(amountCrypto)).toFixed(2);
      const order = { id, type:'CUSTOM_SELL', status:'PENDING_PAYMENT', token, amountCrypto:Number(amountCrypto), priceFiat, fiatCurrency, totalFiat, method, destAddress, holdId, tokenId };
      ORDERS[id] = order;
      if(method==='BANK'){
        order.payment = { status:'PENDING', method:'BANK', instructions:{ iban:'DE89370400440532013000', bic:'COBADEFFXXX', reference:`ORD-${id}` }, amount: totalFiat };
      } else if (stripe){
        const pi = await stripe.paymentIntents.create({ amount: Math.round(totalFiat*100), currency: fiatCurrency.toLowerCase(), capture_method:'manual', metadata:{ orderId:id } }, idem ? { idempotencyKey: idem } : {});
        order.payment = { status:'AUTHORIZED', method:'CARD', provider:'stripe', payment_intent: pi.id, amount: totalFiat };
      } else {
        order.payment = { status:'AUTHORIZED', method:'CARD', provider:'mock', amount: totalFiat };
      }
      return order;
    });
    res.status(201).json(result);
  }catch(e){
    const status = e.status || (e.response && e.response.status) || 500;
    res.status(status).json(e.data || e.response?.data || {error:'SELL_CREATE_FAILED', message: e.message});
  }
});

app.post('/sell-orders/:id/confirm', async (req,res)=>{
  const o = ORDERS[req.params.id];
  if(!o || o.type!=='CUSTOM_SELL') return res.status(404).json({error:'NOT_FOUND'});
  try{
    if(o.method==='CARD' && stripe && o.payment?.payment_intent){
      await stripe.paymentIntents.capture(o.payment.payment_intent);
    } else {
      o.payment = { ...(o.payment||{}), status:'CAPTURED' };
    }
    await axios.post(process.env.CATALOG_URL + '/catalog/internal/commit', { tokenId: o.tokenId, holdId: o.holdId });
    const t = await axios.post(process.env.WALLET_URL + '/transfer', { orderId: o.id, to: o.destAddress, amountCrypto: o.amountCrypto });
    o.tx = t.data; o.status = 'COMPLETED'; res.json(o);
  }catch(e){
    const status = e.status || (e.response && e.response.status) || 500;
    res.status(status).json({error:'SELL_CONFIRM_FAILED', message: e.message});
  }
});

app.post('/sell-orders/:id/cancel', async (req,res)=>{
  const o = ORDERS[req.params.id];
  if(!o || o.type!=='CUSTOM_SELL') return res.status(404).json({error:'NOT_FOUND'});
  try{ await axios.post(process.env.CATALOG_URL + '/catalog/internal/release', { tokenId: o.tokenId, holdId: o.holdId }); o.status='CANCELLED'; res.json(o); }
  catch(e){ res.status(500).json({error:'SELL_CANCEL_FAILED', message: e.message}); }
});

// Webhook for payments (Stripe-like)
app.post('/webhook/payments', (req,res)=>{
  try{
    // For demo we skip signature validation. In production, validate!
    const event = JSON.parse(req.rawBody.toString());
    if(event.type === 'payment_intent.succeeded'){
      const id = event.data.object.metadata?.orderId;
      // In real setup, call internal confirm endpoint or inline commit.
      console.log('payment succeeded for order', id);
    }
    res.sendStatus(200);
  }catch(e){ res.sendStatus(400); }
});

app.listen(3000, () => console.log('orders listening on 3000'));
