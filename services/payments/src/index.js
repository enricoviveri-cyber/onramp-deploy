import express from 'express';
const app = express(); app.use(express.json());
const PAY = {};
app.post('/authorize', (req,res)=>{ const { orderId, amount } = req.body; PAY[orderId] = { status:'AUTHORIZED', amount, threeDS:'CHALLENGE_OK', method:'CARD' }; res.json(PAY[orderId]); });
app.post('/capture', (req,res)=>{ const { orderId } = req.body; if(!PAY[orderId]) return res.status(404).end(); PAY[orderId].status='CAPTURED'; res.json(PAY[orderId]); });
app.post('/bank/confirm', (req,res)=>{ const { orderId, amount } = req.body||{}; res.json({ status:'CAPTURED', method:'BANK', amount }); });
app.listen(3000, ()=>console.log('payments on 3000'));
