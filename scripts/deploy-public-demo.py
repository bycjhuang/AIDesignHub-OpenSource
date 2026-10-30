"""Isolated AIDesignHub site deployment. All mutations require --apply.

Only /srv/aidesignhub-public, its gateway unit and its existing Nginx vhost
are managed. Original BYCJ/PlanPalette services, DNS and databases are untouched.
"""
from __future__ import annotations
import argparse, base64, hashlib, io, json, os, pathlib, re, shlex, subprocess, tarfile, tempfile, zlib
ROOT=pathlib.Path(__file__).resolve().parent.parent
WORK=ROOT/'.runtime/website-demo-20261030'

def ssh_python(code, payload, timeout=120):
    config=pathlib.Path(r'D:\BYCJ\shopfrontdesignfeature\backend-server\deploy.sh').read_text(encoding='utf8')
    host=re.search(r'^SERVER_HOST="([^"\n]+)"',config,re.M).group(1)
    user=re.search(r'^SERVER_USER="([^"\n]+)"',config,re.M).group(1)
    key=pathlib.Path(r'D:\BYCJ\BYCJ-privatekey\aibycjdesignbackend.pem')
    # Keep the disposable key on the user's profile drive, where OpenSSH's
    # restrictive owner ACL is supported. Never alter the original key.
    private=pathlib.Path.home()/'.ssh/adh-public-deploy-tmp';private.mkdir(parents=True,exist_ok=True)
    disposable=None
    try:
        if os.name=='nt':
            with tempfile.NamedTemporaryFile(prefix='ssh-',suffix='.pem',dir=private,delete=False) as stream:
                disposable=pathlib.Path(stream.name);stream.write(key.read_bytes())
            script="$ErrorActionPreference='Stop'; $target=[Environment]::GetEnvironmentVariable('ADH_DEPLOY_KEY'); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.FileSecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'); $acl.AddAccessRule($rule); [IO.File]::SetAccessControl($target,$acl)"
            result=subprocess.run(['powershell','-NoProfile','-NonInteractive','-Command',script],capture_output=True,text=True,env=dict(os.environ,ADH_DEPLOY_KEY=str(disposable)),timeout=15)
            if result.returncode:raise RuntimeError('Could not restrict disposable SSH key: '+result.stderr.replace(str(disposable),'[temporary-key]')[-650:])
            key=disposable
        bootstrap='import base64,zlib,sys;exec(zlib.decompress(base64.b64decode(sys.stdin.readline())))'
        data=base64.b64encode(zlib.compress(code.encode())).decode()+'\n'+json.dumps(payload)
        process=subprocess.run(['ssh','-i',str(key),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15',user+'@'+host,'python3 -c '+shlex.quote(bootstrap)],input=data,capture_output=True,text=True,encoding='utf8',errors='replace',timeout=timeout)
        if process.returncode:
            try:message=json.loads(process.stdout).get('error','Deployment failed')
            except Exception:
                diagnostic=process.stderr.lower()
                reason=next((label for pattern,label in [('syntaxerror','remote-syntax'),('indentationerror','remote-indentation'),('connection timed out','timeout'),('connection reset','reset'),('connection closed','closed'),('host key verification failed','host-key'),('permission denied','permission')] if pattern in diagnostic),'transport')
                message='SSH operation failed ('+reason+'); connection details suppressed'
            raise RuntimeError(message)
        return json.loads(process.stdout)
    finally:
        if disposable and disposable.is_file():disposable.unlink()

REMOTE=r"""
import base64,hashlib,io,json,os,pathlib,pwd,re,shutil,subprocess,sys,tarfile,time,urllib.request
P=json.load(sys.stdin);BASE=pathlib.Path('/srv/aidesignhub-public');NGINX=pathlib.Path('/etc/nginx/conf.d/aidesignhub-public.conf');STATE=BASE/'website-state.json'
UNIT=pathlib.Path('/etc/systemd/system/aidesignhub-public-gateway.service')
def require(ok,msg):
    if not ok:raise RuntimeError(msg)
def run(args,timeout=30):
    p=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    require(p.returncode==0,'Command failed: '+pathlib.Path(args[0]).name)
    return p.stdout.strip()
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def save(p,text,mode=0o644):
    p.parent.mkdir(parents=True,exist_ok=True);temporary=p.with_name(p.name+'.adh-new');temporary.write_text(text);temporary.chmod(mode);os.replace(temporary,p)
def link(target,path):
    temporary=path.with_name(path.name+'.adh-next')
    if temporary.is_symlink():temporary.unlink()
    require(not temporary.exists(),'Unexpected symlink staging path');temporary.symlink_to(target);os.replace(temporary,path)
def protection():
    files={str(p):sha(p) for p in pathlib.Path('/etc/nginx/conf.d').glob('*.conf') if p!=NGINX}
    backend=pathlib.Path('/root/projects/shopfrontdesignfeature/backend/current').resolve()
    return {'nginx':files,'backend':str(backend),'env':sha(backend/'.env'),'planpalette':str(pathlib.Path('/opt/planpalette-web/current').resolve()),'pids':{u:run(['systemctl','show',u,'-p','MainPID','--value']) for u in ['pm2-root','planpalette-web','planpalette-engine']}}
def unchanged(before):require(protection()==before,'Another application changed during deployment; original services were not modified')
def status():
    return {'current':str((BASE/'current').resolve()),'gatewayActive':run(['systemctl','is-active','aidesignhub-public-gateway']) if UNIT.exists() else False,'freeGiB':round(shutil.disk_usage(BASE).free/1024**3,2),'state':json.loads(STATE.read_text()) if STATE.is_file() else None}
try:
    action=P['action']
    if action=='status':print(json.dumps(status()));sys.exit(0)
    require(P.get('apply') is True,'Mutation requires --apply')
    if action=='artifacts':
        directory=BASE/'downloads';directory.mkdir(exist_ok=True);results=[]
        require(shutil.disk_usage(BASE).free>2*1024**3,'Not enough free disk to stage public downloads')
        for artifact in P['artifacts']:
            name=artifact['file'];require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]+',name) and '..' not in name,'Artifact name rejected')
            target=directory/name
            if not target.is_file() or target.stat().st_size!=artifact['bytes'] or sha(target)!=artifact['sha256']:
                partial=directory/(name+'.part')
                url='https://github.com/bycjhuang/AIDesignHub-OpenSource/releases/download/v0.3.2/'+name
                with urllib.request.urlopen(url,timeout=45) as source,partial.open('wb') as output:shutil.copyfileobj(source,output,1024*1024)
                require(partial.stat().st_size==artifact['bytes'] and sha(partial)==artifact['sha256'],'Official artifact hash mismatch')
                partial.chmod(0o644);os.replace(partial,target)
            results.append({'file':name,'bytes':target.stat().st_size,'sha256':sha(target)})
        save(BASE/'downloads-verified.json',json.dumps(results,indent=2));print(json.dumps({'verified':results}));sys.exit(0)
    if action=='stage':
        before=protection();data=base64.b64decode(P['archive']);require(hashlib.sha256(data).hexdigest()==P['sha256'],'Archive digest mismatch')
        release='web-demo-20261030-'+P['sha256'][:12];directory=BASE/'releases'/release
        require(not directory.exists(),'Immutable release already exists; use activate or build a new archive')
        directory.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
            members=archive.getmembers();require(len(members)<2000,'Unexpected package size')
            for member in members:
                name=pathlib.PurePosixPath(member.name);require(not name.is_absolute() and '..' not in name.parts and (member.isfile() or member.isdir()),'Archive path rejected')
                target=directory.joinpath(*name.parts)
                if member.isdir():target.mkdir(parents=True,exist_ok=True)
                else:
                    require(member.size<30*1024*1024,'Unexpected public file size');target.parent.mkdir(parents=True,exist_ok=True)
                    with archive.extractfile(member) as source,target.open('wb') as output:shutil.copyfileobj(source,output)
                    target.chmod(0o644)
        manifest=json.loads((directory/'build-manifest.json').read_text())
        for row in manifest['files']:require((directory/row['path']).stat().st_size==row['bytes'],'Staged public file mismatch: '+row['path'])
        gateway=BASE/'gateway';(gateway/'releases').mkdir(parents=True,exist_ok=True)
        source=base64.b64decode(P['gateway']).decode();gateway_id=hashlib.sha256(source.encode()).hexdigest()[:16]
        save(gateway/'releases'/(gateway_id+'.cjs'),source)
        unchanged(before);print(json.dumps({'release':release,'gateway':gateway_id,'files':len(manifest['files'])}));sys.exit(0)
    if action=='activate':
        before=protection();release=P['release'];gateway_id=P['gateway']
        require(re.fullmatch(r'web-demo-20261030-[a-f0-9]{12}',release) and re.fullmatch(r'[a-f0-9]{16}',gateway_id),'Release identity rejected')
        target=BASE/'releases'/release;require((target/'build-manifest.json').is_file(),'Release is not staged')
        verified=json.loads((BASE/'downloads-verified.json').read_text());require(len(verified)==2,'Official downloads not verified')
        for artifact in verified:require(sha(BASE/'downloads'/artifact['file'])==artifact['sha256'],'Download digest changed')
        previous=str((BASE/'current').resolve());original=NGINX.read_text();old_state=json.loads(STATE.read_text()) if STATE.is_file() else None
        intro=old_state['intro'] if old_state else previous
        require(intro.startswith('/srv/aidesignhub-public/releases/'),'Intro release escaped site directory')
        media=json.loads((target/'intro-media.json').read_text())
        require(re.fullmatch(r'/media/aidesignhub-intro-zh-[a-f0-9]{12}\.mp4',media['url']) and re.fullmatch(r'[a-f0-9]{64}',media['sha256']),'Introduction media identity rejected')
        media_file=BASE/'media'/pathlib.PurePosixPath(media['url']).name
        require(media_file.is_file() and media_file.stat().st_size==media['bytes'] and sha(media_file)==media['sha256'],'Introduction movie is not verified')
        backup=BASE/'deployments'/release;backup.mkdir(parents=True,exist_ok=True)
        save(backup/'before.json',json.dumps({'current':previous,'nginx':original,'state':old_state,'protection':before,'unit':UNIT.read_text() if UNIT.is_file() else None,'gateway':str((BASE/'gateway/current.cjs').resolve()) if (BASE/'gateway/current.cjs').exists() else None}),0o600)
        save(backup/'locations.conf',(BASE/'website-locations.conf').read_text())
        try:pwd.getpwnam('adhpublic')
        except KeyError:run(['useradd','--system','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','adhpublic'])
        backend=pathlib.Path(before['backend']);match=re.search(r'^GATEWAY_SECRET\s*=\s*(.+)$',(backend/'.env').read_text(),re.M)
        require(match is not None,'Existing account gateway is not configured');secret=match.group(1).strip().strip('"\'')
        require(re.fullmatch(r'[A-Za-z0-9_+/=.-]{16,256}',secret),'Existing gateway secret has an unsupported format')
        gateway_env='GATEWAY_SECRET='+secret+'\nADH_DOWNLOAD_MANIFEST=/srv/aidesignhub-public/gateway/downloads.json\nPORT=8789\n'
        previous_gateway=(BASE/'gateway/current.cjs').resolve()
        gateway_changed=not (BASE/'gateway/service.env').is_file() or (BASE/'gateway/service.env').read_text()!=gateway_env or previous_gateway!=BASE/'gateway/releases'/(gateway_id+'.cjs')
        save(BASE/'gateway/service.env',gateway_env,0o600)
        save(BASE/'gateway/downloads.json',json.dumps({'windows':'AIDesignHub-Setup-0.3.2.exe','source':'AIDesignHub-0.3.2-source.zip'}))
        unit='''[Unit]
Description=AIDesignHub BYCJ account and official download gateway
After=network.target
[Service]
Type=simple
User=adhpublic
Group=adhpublic
EnvironmentFile=/srv/aidesignhub-public/gateway/service.env
ExecStart=/usr/local/bin/node /srv/aidesignhub-public/gateway/current.cjs
Restart=on-failure
RestartSec=3
MemoryMax=128M
CPUQuota=25%
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/srv/aidesignhub-public/gateway
UMask=0077
[Install]
WantedBy=multi-user.target
'''
        gateway_changed=gateway_changed or not UNIT.is_file() or UNIT.read_text()!=unit
        save(UNIT,unit);link(BASE/'gateway/releases'/(gateway_id+'.cjs'),BASE/'gateway/current.cjs')
        run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','aidesignhub-public-gateway'])
        if gateway_changed:run(['systemctl','restart','aidesignhub-public-gateway'])
        for _ in range(15):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8789/api/account/health',timeout=2) as response:health=json.load(response)
                require(health.get('ok') and health.get('service')=='aidesignhub-account-download' and health.get('projectBackend') is False,'Gateway identity check failed')
                break
            except Exception:time.sleep(0.3)
        else:raise RuntimeError('Gateway did not become healthy')
        locations='''# AIDesignHub isolated public workbench routes
location ^~ /api/account/ { proxy_pass http://127.0.0.1:8789; proxy_set_header X-Real-IP $remote_addr; proxy_set_header Host $host; proxy_read_timeout 25s; client_max_body_size 8k; }
location ^~ /api/downloads/ { proxy_pass http://127.0.0.1:8789; proxy_set_header X-Real-IP $remote_addr; proxy_set_header Host $host; proxy_read_timeout 25s; }
location ^~ /__adh_downloads/ { internal; alias /srv/aidesignhub-public/downloads/; }
location ^~ /_next/ { alias /srv/aidesignhub-public/current/design/_next/; expires 1h; }
location ^~ /excalidraw-assets/ { alias /srv/aidesignhub-public/current/design/excalidraw-assets/; expires 1h; }
location ~ ^/(home|canvas|projects|project|brand-kit|settings|skills|pricing|hub|credits|billing)\.txt$ { root /srv/aidesignhub-public/current/design; types { text/x-component txt; } try_files $uri =404; }
location ~ ^/(home|canvas|projects|project|brand-kit|settings|skills|pricing|hub|credits|billing)/?$ { root /srv/aidesignhub-public/current/design; try_files /$1.html =404; }
location = /ai-design-hub-icon.png { alias /srv/aidesignhub-public/current/design/ai-design-hub-icon.png; }
location ^~ /intro/ { alias INTRO_PATH/; index index.html; }
'''.replace('INTRO_PATH',intro)
        locations+='location = '+media['url']+' { alias '+str(media_file)+'; add_header Cache-Control "public, max-age=31536000, immutable"; }\n'
        save(BASE/'website-locations.conf',locations)
        include='    include /srv/aidesignhub-public/website-locations.conf;\n'
        if include not in original:
            require(original.count('    location = /_headers')==2,'Existing dedicated Nginx vhost layout changed')
            updated=original.replace('    location = /_headers',include+'    location = /_headers')
        else:updated=original
        updated=updated.replace('    location / { try_files $uri $uri/ =404; }','    location / { add_header Cache-Control "no-cache"; try_files $uri $uri/ =404; }')
        link(target,BASE/'current');save(NGINX,updated)
        try:run(['/usr/sbin/nginx','-t']);run(['systemctl','reload','nginx'])
        except Exception:
            save(BASE/'website-locations.conf',(backup/'locations.conf').read_text());save(NGINX,original);link(pathlib.Path(previous),BASE/'current');raise
        unchanged(before)
        state={'release':release,'gateway':gateway_id,'previous':previous,'intro':intro,'activatedAt':time.time()}
        save(STATE,json.dumps(state,indent=2),0o600);print(json.dumps({'active':state,'protectedApplicationsUnchanged':True,'freeGiB':round(shutil.disk_usage(BASE).free/1024**3,2)}));sys.exit(0)
    if action=='rollback':
        current=json.loads(STATE.read_text());backup=json.loads((BASE/'deployments'/current['release']/'before.json').read_text())
        require(backup['current'].startswith('/srv/aidesignhub-public/releases/'),'Rollback target escaped site directory')
        locations_backup=BASE/'deployments'/current['release']/'locations.conf'
        if locations_backup.is_file():save(BASE/'website-locations.conf',locations_backup.read_text())
        save(NGINX,backup['nginx']);link(pathlib.Path(backup['current']),BASE/'current');run(['/usr/sbin/nginx','-t']);run(['systemctl','reload','nginx'])
        if backup['gateway']:link(pathlib.Path(backup['gateway']),BASE/'gateway/current.cjs');run(['systemctl','restart','aidesignhub-public-gateway'])
        else:run(['systemctl','stop','aidesignhub-public-gateway'])
        if backup['state']:save(STATE,json.dumps(backup['state']),0o600)
        else:save(STATE,json.dumps({'rolledBackTo':backup['current'],'intro':backup['current']}),0o600)
        print(json.dumps({'rolledBackTo':backup['current']}));sys.exit(0)
    raise RuntimeError('Unknown deployment action')
except Exception as exc:
    print(json.dumps({'error':str(exc)}));sys.exit(1)
"""

def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['artifacts','stage','activate','status','rollback']);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    if args.action!='status' and not args.apply:parser.error('Mutations require --apply')
    payload={'action':args.action,'apply':args.apply}
    if args.action=='artifacts':
        manifest=pathlib.Path.home()/'Desktop/AIDesignHub-0.3.2-开源安装包/AIDesignHub-0.3.2.manifest.json'
        payload['artifacts']=json.loads(manifest.read_text(encoding='utf8'))['artifacts']
    if args.action=='stage':
        buffer=io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w:gz',compresslevel=5) as archive:
            for file in sorted((WORK/'dist').rglob('*')):
                if file.is_file():archive.add(file,arcname=str(file.relative_to(WORK/'dist')).replace('\\','/'))
        data=buffer.getvalue();payload.update(archive=base64.b64encode(data).decode(),sha256=hashlib.sha256(data).hexdigest(),gateway=base64.b64encode((ROOT/'web-public/server.cjs').read_bytes()).decode())
    if args.action=='activate':payload.update(json.loads((WORK/'stage-receipt.json').read_text()))
    result=ssh_python(REMOTE,payload,timeout=1800 if args.action=='artifacts' else 180)
    WORK.mkdir(parents=True,exist_ok=True);(WORK/(args.action+'-receipt.json')).write_text(json.dumps(result,indent=2),encoding='utf8')
    print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
