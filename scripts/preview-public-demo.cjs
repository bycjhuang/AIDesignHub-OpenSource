'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../.runtime/website-demo-20261030/dist');
const intro=path.resolve(__dirname,'../.runtime/website-public-20261029/dist');
const introMedia=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../web-public/intro-media.json'),'utf8'));
const types={'.html':'text/html; charset=utf-8','.txt':'text/x-component; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.woff':'font/woff','.mp4':'video/mp4','.m4a':'audio/mp4'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');let pathname=decodeURIComponent(url.pathname);
  if(pathname===introMedia.url){
    const file=path.resolve(__dirname,'../.runtime/public-intro-media',path.basename(pathname));
    if(!fs.existsSync(file)){res.writeHead(404);return res.end();}
    const size=fs.statSync(file).size,range=req.headers.range;
    let start=0,end=size-1,status=200;
    if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));end=match[1]&&match[2]?Math.min(Number(match[2]),size-1):size-1;if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}status=206;}
    res.writeHead(status,{'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes',...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
    if(req.method==='HEAD')return res.end();return fs.createReadStream(file,{start,end}).pipe(res);
  }
  if(pathname.startsWith('/api/')){res.writeHead(pathname==='/api/account/health'?200:401,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'本地预览不连接真实账号，请在正式网站登录。'}));}
  let base=root,relative=pathname.replace(/^\//,'');
  if(pathname.startsWith('/intro/')){base=intro;relative=pathname.slice(7)||'index.html';}
  else if(pathname.startsWith('/_next/')||pathname.startsWith('/excalidraw-assets/'))relative='design'+pathname;
  else if(/^\/(home|canvas|projects|project|brand-kit|settings|skills|pricing|hub|credits|billing)\.txt$/.test(pathname)||pathname==='/ai-design-hub-icon.png')relative='design'+pathname;
  else if(/^\/(home|canvas|projects|project|brand-kit|settings|skills|pricing|hub|credits|billing)\/?$/.test(pathname))relative='design'+pathname.replace(/\/$/,'')+'.html';
  if(!relative)relative='index.html';
  let file=path.resolve(base,relative);
  if(!file.startsWith(base+path.sep)&&file!==base){res.writeHead(403);return res.end();}
  if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
  if(!fs.existsSync(file)){console.log('404 '+pathname);res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
});
server.listen(8799,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:8799'));
