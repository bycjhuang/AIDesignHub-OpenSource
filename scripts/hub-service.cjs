#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {AgentHub}=require('../backend/agent-hub.cjs');
const {AgentGateway}=require('../backend/agent-gateway.cjs');
const {executeAgent}=require('../backend/agent-executors.cjs');
const {acquireServiceLock}=require('../backend/service-lock.cjs');
const {CaseResearchService}=require('../backend/case-research.cjs');
async function main() {
  const dataDir=process.env.AIDESIGNHUB_DATA_DIR;
  if(!dataDir||!path.isAbsolute(dataDir))throw new Error('Set AIDESIGNHUB_DATA_DIR to an explicit absolute data directory. Never run a second service against a desktop-owned directory.');
  const release=acquireServiceLock(dataDir);let hub;let gateway;let cases;
  try {const backend=new LocalBackend({dataDir});hub=new AgentHub({backend,execute:executeAgent});cases=new CaseResearchService({backend,hub});gateway=new AgentGateway({hub,port:Number(process.env.AIDESIGNHUB_PORT)||backend.store.settings.agentPort||0});const status=await gateway.start();hub.setGateway({url:status.url,command:process.execPath,mcpScript:path.join(__dirname,'hub-mcp.cjs'),cliScript:path.join(__dirname,'hub-cli.cjs')});backend.mutate(store=>{store.settings.agentPort=status.port;return true;});process.stdout.write(JSON.stringify({service:'AIDesignHub',...status})+'\n');}
  catch(error){release();throw error;}
  const stop=async()=>{cases.dispose();hub.dispose();await gateway.stop();release();process.exit(0);};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
