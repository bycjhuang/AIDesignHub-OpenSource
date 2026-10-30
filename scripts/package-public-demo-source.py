"""Package the explicit public website sources; never include runtime/user data."""
from pathlib import Path
import sys, zipfile
ROOT=Path(__file__).resolve().parent.parent
def main():
    output=Path(sys.argv[1]);output.parent.mkdir(parents=True,exist_ok=True)
    names=['scripts/build-public-demo.cjs','scripts/cache-public-demo-assets.py','scripts/preview-public-demo.cjs','scripts/package-public-demo-source.py','scripts/deploy-public-demo.py','tests/public-site-account.test.cjs','LICENSE','NOTICE','THIRD-PARTY-NOTICES.md','index.html']
    names += [str(p.relative_to(ROOT)).replace('\\','/') for p in (ROOT/'web-public').iterdir() if p.is_file() and p.suffix in ['.cjs','.js','.css','.html','.md']]
    names += ['backend/dsh-plugins/adh-brand/'+name for name in ['client.js','index.js','package.json']]
    names += ['tests/public-agent-theme.test.cjs']
    names += ['web-public/intro-media.json','web-public/intro-cover.jpg','scripts/publish-public-intro.py']
    html=(ROOT/'index.html').read_text(encoding='utf8')
    import re
    names += [m.group(1) for m in re.finditer(r'(?:src|href)="([^"?#]+\.(?:js|css))"',html)]
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        for name in sorted(set(names)):
            file=(ROOT/name).resolve()
            if not file.is_relative_to(ROOT) or not file.is_file() or file.is_symlink():raise ValueError('Source allowlist rejected')
            archive.write(file,name)
if __name__=='__main__':main()
