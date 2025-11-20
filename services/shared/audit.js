export function audit(req,res,next){
  const start = Date.now();
  res.on('finish', ()=> {
    try{
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        ip: req.ip,
        user: req.headers['x-auth-request-email'] || req.headers['x-user'] || 'anon',
        path: req.originalUrl, method: req.method, status: res.statusCode,
        latency_ms: Date.now() - start, trace_id: req.headers['x-trace-id'] || null
      }));
    }catch(e){}
  });
  next();
}
