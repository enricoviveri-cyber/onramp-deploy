import express from 'express';
import { v4 as uuid } from 'uuid';
const app = express(); app.use(express.json());
app.post('/transfer', (req,res)=>{ const { orderId, to, amountCrypto } = req.body; const txId = uuid().slice(0,8); res.json({ txId, network:'mocknet', to, amountCrypto }); });
app.listen(3000, ()=>console.log('wallet on 3000'));
