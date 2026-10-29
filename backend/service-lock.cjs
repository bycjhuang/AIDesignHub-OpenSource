'use strict';
const fs=require('node:fs');
const path=require('node:path');
function acquireServiceLock(dataDir) {
  fs.mkdirSync(dataDir,{recursive:true});const file=path.join(dataDir,'service-owner.lock');
  let owned=false;
  for(let attempt=0;attempt<2;attempt++) {
    try {const fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,createdAt:Date.now()}));fs.closeSync(fd);owned=true;break;}
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      let owner;try{owner=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error('服务锁无法读取，请检查是否有其他 Hub 服务正在运行。');}
      if(!Number.isInteger(owner.pid)||owner.pid<=0)throw new Error('无效服务锁，请人工核实后处理。');
      try{process.kill(owner.pid,0);throw new Error(`此数据目录已由 Hub 进程 ${owner.pid} 管理。请使用它的接口，不要启动第二个写入者。`);}catch(probe){if(probe.code!=='ESRCH')throw probe;}
      const current=JSON.parse(fs.readFileSync(file,'utf8'));if(current.pid!==owner.pid||current.createdAt!==owner.createdAt)throw new Error('服务锁发生变化，请重试。');
      fs.unlinkSync(file);
    }
  }
  if(!owned)throw new Error('无法取得项目服务锁。');
  return () => {if(!owned)return;try{const owner=JSON.parse(fs.readFileSync(file,'utf8'));if(owner.pid===process.pid)fs.unlinkSync(file);}finally{owned=false;}};
}
module.exports={acquireServiceLock};
