import express from 'express';
import fs from 'fs';
const app = express();
const COVERAGE_PATH = process.env.COVERAGE_PATH || '/data/coverage.json';

app.get('/api/v1/public/crypto-currencies', (req, res) => {
  try{
    const json = JSON.parse(fs.readFileSync(COVERAGE_PATH, 'utf-8'));
    const networkParam = (req.query.network || '').toString().toLowerCase();
    const search = (req.query.search || '').toString().toLowerCase();
    const networks = networkParam ? networkParam.split(',').map(s => s.trim()) : null;
    let list = json.cryptocurrencies;
    if (networks) list = list.filter(x => networks.includes((x.network || '').toLowerCase()));
    if (search) list = list.filter(x => (x.name||'').toLowerCase().includes(search) || (x.symbol||'').toLowerCase().includes(search));
    const result = list.map(x => ({
      name: x.name, symbol: x.symbol, network: x.network, chainId: x.chainId, decimals: x.decimals,
      contractAddress: x.contractAddress, isAllowed: x.isAllowed, isPopular: x.isPopular, logoUrl: x.logoUrl
    }));
    res.json({ version: json.version, updatedAt: json.updatedAt, cryptocurrencies: result });
  }catch(e){
    res.status(500).json({ error:'COVERAGE_READ_ERROR', message:e.message });
  }
});

app.get('/cryptocoverage/api/v1/public/crypto-currencies', (req,res)=>{
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(307, '/api/v1/public/crypto-currencies' + qs);
});

app.listen(3000, ()=>console.log('coverage on 3000'));
