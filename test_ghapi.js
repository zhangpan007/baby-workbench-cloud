const https = require('https');
const GH_TIMEOUT_MS = 8000;
function githubApi(method, body, hostname, path) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization':'Bearer x','Accept':'application/vnd.github+json','Content-Type':'application/json','User-Agent':'t' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({ hostname, path, method, family:4, headers }, (res) => {
      let buf=''; res.setEncoding('utf8');
      res.on('data',c=>{buf+=c;});
      res.on('end',()=>{ clearTimeout(timer); resolve({status:res.statusCode, ok:res.statusCode>=200&&res.statusCode<300}); });
    });
    const timer = setTimeout(()=>{ req.destroy(new Error('GitHub request timeout')); }, GH_TIMEOUT_MS);
    req.on('error',(e)=>{ clearTimeout(timer); reject(e); });
    if (payload) req.write(payload);
    req.end();
  });
}
(async()=>{
  const t1=Date.now();
  try { const r = await githubApi('PUT',{message:'t',content:'eA=='},'api.github.com','/repos/zhangpan007/baby-workbench-cloud/contents/x.txt'); console.log('TEST1 real github status=',r.status,'ms=',Date.now()-t1); }
  catch(e){ console.log('TEST1 real github ERR=',e.message,'ms=',Date.now()-t1); }
  const t2=Date.now();
  try { const r = await githubApi('PUT',{message:'t',content:'eA=='},'192.0.2.1','/x'); console.log('TEST2 unreachable status=',r.status,'ms=',Date.now()-t2); }
  catch(e){ console.log('TEST2 unreachable ERR=',e.message,'ms=',Date.now()-t2); }
})();
