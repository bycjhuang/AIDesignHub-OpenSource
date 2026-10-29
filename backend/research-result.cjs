'use strict';

const MAX_CHARS=500000,MAX_CANDIDATES=100;
function invalid(code){const error=new Error('调研成果不是唯一且完整的 JSON，请让执行器只返回一个 JSON 对象。');error.code=code;return error;}

// Scan balanced containers only to locate a candidate; JSON.parse remains the
// sole parser. Natural-language prefixes are never evaluated or repaired.
function objectEnd(text,start){
  let depth=0,quoted=false,escaped=false;
  for(let i=start;i<text.length;i++){
    const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0)return i+1;
  }
  return -1;
}
function prefixIsUnambiguous(prefix){
  let count=0,budget=MAX_CHARS*2;
  for(let start=prefix.indexOf('{');start!==-1;start=prefix.indexOf('{',start+1)){
    if(++count>MAX_CANDIDATES)throw invalid('RESEARCH_TOO_MANY_CANDIDATES');
    const end=objectEnd(prefix,start);budget-=end<0?prefix.length-start:end-start;if(budget<0)throw invalid('RESEARCH_SCAN_LIMIT');
    if(end<0){if(/^\{\s*"/.test(prefix.slice(start)))throw invalid('RESEARCH_INCOMPLETE_JSON');continue;}
    let parsed;try{parsed=JSON.parse(prefix.slice(start,end));}catch{if(/^\{\s*"/.test(prefix.slice(start,end)))throw invalid('RESEARCH_AMBIGUOUS_JSON');continue;}
    // Literal inline empty braces in prose are not a second result. A standalone
    // empty object or any populated JSON object is an ambiguous earlier result.
    const lineStart=prefix.lastIndexOf('\n',start-1)+1,nextLine=prefix.indexOf('\n',end),lineEnd=nextLine<0?prefix.length:nextLine;
    const inline=prefix.slice(lineStart,start).trim()||prefix.slice(end,lineEnd).trim();
    if(Object.keys(parsed).length||!inline)throw invalid('RESEARCH_AMBIGUOUS_JSON');
  }
}
function parseResearchResult(raw){
  if(typeof raw!=='string'||raw.length>MAX_CHARS)throw invalid('RESEARCH_RESULT_LIMIT');
  const text=raw.trim();if(!text)throw invalid('RESEARCH_EMPTY_RESULT');
  try{return JSON.parse(text);}catch{}
  const fences=[...text.matchAll(/^ {0,3}```([^\r\n]*)\r?$/gm)];
  if(fences.length>MAX_CANDIDATES)throw invalid('RESEARCH_TOO_MANY_CANDIDATES');
  let body=text,offset=0;
  if(fences.length){
    const close=fences.at(-1),open=fences.at(-2);
    if(!open||close[1].trim()||close.index+close[0].length!==text.length||!/^(?:json)?$/i.test(open[1].trim()))throw invalid('RESEARCH_INVALID_FENCE');
    body=text.slice(open.index+open[0].length,close.index).trim();offset=open.index;
    let parsed;try{parsed=JSON.parse(body);}catch{throw invalid('RESEARCH_INVALID_JSON');}
    prefixIsUnambiguous(text.slice(0,offset));return parsed;
  }
  if(!text.endsWith('}'))throw invalid('RESEARCH_TRAILING_CONTENT');
  let count=0,budget=MAX_CHARS*2,selected=null;
  for(let start=text.indexOf('{');start!==-1;start=text.indexOf('{',start+1)){
    if(++count>MAX_CANDIDATES)throw invalid('RESEARCH_TOO_MANY_CANDIDATES');
    const end=objectEnd(text,start);budget-=end<0?text.length-start:end-start;if(budget<0)throw invalid('RESEARCH_SCAN_LIMIT');
    if(end!==text.length)continue;
    try{selected={start,value:JSON.parse(text.slice(start))};break;}catch{}
  }
  if(!selected)throw invalid('RESEARCH_INVALID_JSON');
  prefixIsUnambiguous(text.slice(0,selected.start));return selected.value;
}
module.exports={parseResearchResult};
