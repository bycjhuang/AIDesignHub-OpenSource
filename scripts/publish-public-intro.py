"""Prepare/publish the approved, unchanged Chinese introduction movie only."""
from pathlib import Path
import argparse,base64,hashlib,importlib.util,json,shutil,subprocess

ROOT=Path(__file__).resolve().parent.parent
META=json.loads((ROOT/'web-public/intro-media.json').read_text(encoding='utf8'))
SOURCE=Path.home()/'Desktop/AI Design Hub视频成片/AI Design Hub_横版_中文.mp4'
CACHE=ROOT/'.runtime/public-intro-media'/Path(META['url']).name
spec=importlib.util.spec_from_file_location('adh_deploy',Path(__file__).with_name('deploy-public-demo.py'))
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)

REMOTE=r'''
import base64,hashlib,json,os,pathlib,re,shutil,sys
p=json.load(sys.stdin)
def require(ok,message):
 if not ok:raise RuntimeError(message)
def sha(path):
 digest=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
 return digest.hexdigest()
try:
 require(p.get('apply') is True,'Publication requires --apply')
 meta=p['media'];name=pathlib.PurePosixPath(meta['url']).name
 require(re.fullmatch(r'aidesignhub-intro-zh-[a-f0-9]{12}\.mp4',name) and re.fullmatch(r'[a-f0-9]{64}',meta['sha256']),'Media identity rejected')
 require(name=='aidesignhub-intro-zh-'+meta['sha256'][:12]+'.mp4' and 0<meta['bytes']<300*1024**2,'Media limits rejected')
 directory=pathlib.Path('/srv/aidesignhub-public/media');directory.mkdir(exist_ok=True)
 target=directory/name;partial=directory/(name+'.upload')
 if target.exists():
  require(target.is_file() and target.stat().st_size==meta['bytes'] and sha(target)==meta['sha256'],'Immutable movie differs')
  print(json.dumps({'complete':True,'bytes':meta['bytes'],'sha256':meta['sha256']}));sys.exit(0)
 if p['action']=='status':
  require(shutil.disk_usage(directory).free>meta['bytes']+512*1024**2,'Insufficient free media storage')
  print(json.dumps({'complete':False,'offset':partial.stat().st_size if partial.exists() else 0,'prefixSha256':sha(partial) if partial.exists() else None}));sys.exit(0)
 if p['action']=='chunk':
  data=base64.b64decode(p['chunk'],validate=True);offset=p['offset']
  require(0<len(data)<=8*1024**2 and offset>=0 and offset+len(data)<=meta['bytes'],'Chunk bounds rejected')
  require(hashlib.sha256(data).hexdigest()==p['chunkSha256'],'Chunk digest differs')
  size=partial.stat().st_size if partial.exists() else 0
  if size==offset:
   with partial.open('ab') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
   partial.chmod(0o600)
  else:
   require(size>=offset+len(data),'Unexpected media upload offset')
   with partial.open('rb') as stream:stream.seek(offset);require(stream.read(len(data))==data,'Previously uploaded chunk differs')
  print(json.dumps({'offset':offset+len(data)}));sys.exit(0)
 require(p['action']=='finish','Unknown media action')
 require(partial.is_file() and partial.stat().st_size==meta['bytes'] and sha(partial)==meta['sha256'],'Complete movie digest differs')
 partial.chmod(0o644);os.replace(partial,target)
 print(json.dumps({'complete':True,'bytes':meta['bytes'],'sha256':meta['sha256']}))
except Exception as error:
 print(json.dumps({'error':str(error)}));sys.exit(1)
'''

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['prepare','publish']);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
 if not SOURCE.is_file() or SOURCE.stat().st_size!=META['bytes']:raise RuntimeError('Approved movie is missing or changed')
 with SOURCE.open('rb') as stream:
  if hashlib.file_digest(stream,'sha256').hexdigest()!=META['sha256']:raise RuntimeError('Approved movie digest differs')
 if args.action=='prepare':
  CACHE.parent.mkdir(parents=True,exist_ok=True)
  if not CACHE.exists():shutil.copyfile(SOURCE,CACHE)
  with CACHE.open('rb') as stream:
   if hashlib.file_digest(stream,'sha256').hexdigest()!=META['sha256']:raise RuntimeError('Preview cache digest differs')
  poster=ROOT/'web-public/intro-cover.jpg'
  if not poster.exists():subprocess.run(['ffmpeg','-v','error','-n','-ss','2','-i',str(SOURCE),'-frames:v','1','-vf','scale=1280:-1','-q:v','3',str(poster)],check=True)
  print(json.dumps({'prepared':True,'bytes':META['bytes'],'sha256':META['sha256']}));return
 if not args.apply:raise RuntimeError('Publication requires --apply')
 def call(action,**values):return deploy.ssh_python(REMOTE,{'action':action,'apply':True,'media':META,**values},timeout=180)
 state=call('status')
 if not state['complete']:
  offset=state['offset']
  with SOURCE.open('rb') as stream:
   if offset and hashlib.sha256(stream.read(offset)).hexdigest()!=state['prefixSha256']:raise RuntimeError('Partial upload differs from the approved movie')
   stream.seek(offset)
   while data:=stream.read(8*1024**2):
    result=call('chunk',offset=offset,chunk=base64.b64encode(data).decode(),chunkSha256=hashlib.sha256(data).hexdigest())
    offset=result['offset'];print(json.dumps({'uploadedBytes':offset,'totalBytes':META['bytes']}),flush=True)
  state=call('finish')
 receipt=ROOT/'.runtime/website-demo-20261030/intro-media-receipt.json';receipt.write_text(json.dumps(state,indent=2),encoding='utf8');print(json.dumps(state))

if __name__=='__main__':main()
