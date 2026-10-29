'use strict';
// Only injected when the explicitly isolated Electron smoke test is enabled.
const zlib=require('node:zlib');
const sourceUrl='https://cases.example.org/museum?from=smoke#details';
const imageUrl='https://images.example.org/museum-cover.png';
const page={url:sourceUrl,finalUrl:'https://cases.example.org/museum',title:'江湾美术馆',description:'公开页面测试样本：临水展厅、公共步道与庭院共同组成美术馆。',text:'项目名称：江湾美术馆\n建筑面积：12000平方米\n项目类型：美术馆\n项目地址：上海市黄浦区\n设计单位：测试设计院\n发布时间：2026年10月4日\n\n项目沿滨水步道展开，展厅围绕公共庭院组织。\n这是本地生成的阅读预览测试资料，不是真实项目调研成果。\n<script>window.caseReaderXss=true</script>\n',images:[{url:imageUrl,alt:'仅用于隔离烟测的项目封面样本'}],retrievedAt:Date.now()};
// A deterministic PNG fixture. No image request or live website is needed for smoke QA.
function crc32(buffer){let value=0xffffffff;for(const byte of buffer){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function pngChunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);}
function previewPng(){const width=400,height=240,stride=width*3+1,pixels=Buffer.alloc(stride*height);for(let y=0;y<height;y++){for(let x=0;x<width;x++){const offset=y*stride+1+x*3;const building=y>72&&y<182&&((x>55&&x<178)||(x>200&&x<349));pixels[offset]=building?232:133+Math.floor(y/4);pixels[offset+1]=building?226:161+Math.floor(y/7);pixels[offset+2]=building?211:178+Math.floor(y/9);}}const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',zlib.deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);}
const imageDataUrl=`data:image/png;base64,${previewPng().toString('base64')}`;
async function fetchPage(url){if(url!==sourceUrl)throw new Error('烟测只允许固定案例样本。');return {...page};}
async function fetchImage(url){if(url!==imageUrl)throw new Error('烟测只允许固定图片样本。');return {sourceUrl:url,finalUrl:url,dataUrl:imageDataUrl,width:400,height:240,contentType:'image/png'};}
module.exports={sourceUrl,page,imageUrl,imageDataUrl,fetchPage,fetchImage};
