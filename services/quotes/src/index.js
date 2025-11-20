import express from 'express';
const app = express();
app.get('/quote', (req, res) => {
  const fiatAmount = Number(req.query.fiatAmount || 100);
  const rate = 1.05;
  const cryptoAmount = +(fiatAmount / rate).toFixed(6);
  res.json({ rate, cryptoAmount, expiresAt: new Date(Date.now()+60_000).toISOString() });
});
app.listen(3000, () => console.log('quotes on 3000'));
