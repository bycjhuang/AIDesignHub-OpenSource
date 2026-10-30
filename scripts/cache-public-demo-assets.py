"""Freeze only the sixteen public discovery thumbnails used by the original UI."""
from pathlib import Path
import concurrent.futures, json, re, urllib.request
ROOT=Path(__file__).resolve().parent.parent
CACHE=ROOT/'.runtime/website-demo-20261030/discovery'
PREFIX='https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/'

def main():
    source=(ROOT/'Loomic-main/Loomic-main/apps/web/src/lib/home-discovery-seeds.ts').read_text(encoding='utf8')
    urls=sorted(set(re.findall(re.escape(PREFIX)+r'[a-z/-]+\.(?:webp|svg)',source)))
    def download(url):
        relative=url[len(PREFIX):];target=CACHE/relative
        if not target.exists():
            with urllib.request.urlopen(url,timeout=20) as response:data=response.read(5*1024*1024+1)
            if len(data)>5*1024*1024:raise ValueError('Unexpected discovery asset size')
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
        return {'url':url,'local':'/discovery/'+relative}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:assets=list(pool.map(download,urls))
    CACHE.mkdir(parents=True,exist_ok=True);(CACHE/'manifest.json').write_text(json.dumps(assets,indent=2),encoding='utf8')
    print(json.dumps({'assets':len(assets)}))
if __name__=='__main__':main()
