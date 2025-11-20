import express from 'express';
const app = express(); app.use(express.json());
const SESS = {};
app.post('/start', (req,res)=>{
  const { orderId } = req.body; SESS[orderId] = { status: 'PENDING', url: `https://mock-kyc/${orderId}` };
  res.json(SESS[orderId]);
});
app.listen(3000, ()=>console.log('kyc on 3000'));
