import express from 'express';
import { getAddress } from 'ethers';
import * as bitcoin from 'bitcoinjs-lib';
import { PublicKey } from '@solana/web3.js';

const app = express();
function isEth(addr){ try { getAddress(addr); return true; } catch { return false; } }
function isBtc(addr){ try { bitcoin.address.toOutputScript(addr, bitcoin.networks.bitcoin); return true; } catch { return false; } }
function isSol(addr){ try { return (new PublicKey(addr)).toBase58() === addr; } catch { return false; } }

app.get('/verify-wallet-address', (req,res)=>{
  const address = (req.query.address||'').toString();
  const network = (req.query.network||'').toString().toLowerCase();
  let valid=false;
  if (network==='ethereum') valid = isEth(address);
  else if (network==='bitcoin') valid = isBtc(address);
  else if (network==='solana') valid = isSol(address);
  res.json({ valid });
});

app.listen(3000, ()=>console.log('verifywallet on 3000'));
