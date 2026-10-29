'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const local=path.join(root,'.runtime',process.platform==='win32'?'electron.exe':'electron');
let executable;
try{executable=fs.existsSync(local)?local:require('electron');}catch{console.error('请先在项目目录运行 npm ci，安装锁定版本的 Electron。');process.exit(1);}
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const modeArgs=process.argv.includes('--demo-company')?['--demo-company']:[];
const child=spawn(executable,[root,...modeArgs],{cwd:root,env,stdio:'inherit',shell:false,windowsHide:false});
child.on('error',()=>{console.error('无法启动 Electron，请检查运行环境。');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
