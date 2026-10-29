'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseResearchResult}=require('../backend/research-result.cjs');
const {CaseResearchService}=require('../backend/case-research.cjs');
test('research result parses complete JSON first and preserves array type for business validation',()=>{
  const payload={name:'项目',quoted:'a { b } " c'};assert.deepEqual(parseResearchResult(` ${JSON.stringify(payload)} `),payload);
  assert.deepEqual(parseResearchResult('[{"name":"项目"}]'),[{name:'项目'}]);
});
test('research result accepts progress then a unique final object or final JSON fence',()=>{
  const payload={name:'合成项目',evidence:[],summary:'原文含 {} 与 "转义" 字符'};
  for(const raw of [`已搜索，正在核对。\n${JSON.stringify(payload)}`,`先搜索，再读取。\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,`\`\`\`JSON\r\n${JSON.stringify(payload)}\r\n\`\`\``])assert.deepEqual(parseResearchResult(raw),payload);
});
test('ordinary prose braces do not become a second result',()=>{
  assert.deepEqual(parseResearchResult('说明包含 {} 字符及 {example} 占位。\n{"ok":true}'),{ok:true});
});
test('research result rejects malformed results trailing prose and ambiguous multiple objects',()=>{
  for(const raw of ['{"ok":true','{"ok":true}\n完成了','{"ok":true}\n{"ok":false}','结果如下\n{"ok":true,}\n','结果\n{"outer":\n{"ok":true}','\`\`\`json\n{"ok":true}\n\`\`\`\n完成','\`\`\`json\n{"ok":true}\n\`\`\`\n\`\`\`json\n{"ok":false}\n\`\`\`'])assert.throws(()=>parseResearchResult(raw),/唯一且完整/);
});
test('research result enforces input and candidate bounds without evaluating code',()=>{
  assert.throws(()=>parseResearchResult('x'.repeat(500001)),error=>error.code==='RESEARCH_RESULT_LIMIT');
  assert.throws(()=>parseResearchResult('正文 {invalid} '.repeat(101)+'\n{"ok":true}'),/唯一且完整/);
  assert.throws(()=>parseResearchResult('(()=>({"ok":true}))()'),/唯一且完整/);
});
test('business schema still rejects JSON arrays even though the transport parser preserves them',()=>{
  const run={output:'[{"matchStatus":"matched","evidence":[]}]'};
  assert.throws(()=>CaseResearchService.prototype.nameOutput.call({},run),/缺少有效/);
  assert.throws(()=>CaseResearchService.prototype.parseAgentResult.call({},{},run),/缺少字段证据/);
});
test('name result parser accepts a progress prefix without mutating the original Hub output',()=>{
  const payload={matchStatus:'not_found',evidence:[],summary:'公开来源不足'};
  const output=`搜索已完成，现在整理结果。\n${JSON.stringify(payload)}`,run={output};
  assert.deepEqual(CaseResearchService.prototype.nameOutput.call({},run),payload);assert.equal(run.output,output);
});
