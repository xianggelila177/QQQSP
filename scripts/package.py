"""Package the checked source with Python stdlib; do not run legacy release.mjs.
Usage: python3 scripts/package.py /mnt/data/qqqsp-v2.14.0-source.zip
       python3 scripts/package.py --verify /mnt/data/qqqsp-v2.14.0-source.zip
Run scripts/verify.mjs and tests/run.mjs BEFORE packaging; this is not a test gate.
"""
from pathlib import Path, PurePosixPath
import hashlib, json, stat, sys, zipfile
ROOT=Path(__file__).resolve().parents[1]
DIRECTORIES={'lib','public','data','ops','docs','scripts','tests'}
EXCLUDE={'node_modules','.git','__pycache__','logs','state','dist','.pytest_cache'}
HIDDEN={'.env.example','.gitignore','.dockerignore'}
def digest(data): return hashlib.sha256(data).hexdigest()
def verify(target):
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None, 'ZIP CRC mismatch'
        names=archive.namelist();assert len(names)==len(set(names)), 'Duplicate entries'
        prefixes={name.split('/')[0] for name in names};assert len(prefixes)==1
        prefix=next(iter(prefixes))+'/'
        for name in names:
            p=PurePosixPath(name)
            assert not p.is_absolute() and '..' not in p.parts and '\\' not in name
        manifest=archive.read(prefix+'SHA256SUMS').decode().splitlines()
        expected={}
        for line in manifest:
            sha,relative=line.split('  ',1);expected[prefix+relative]=sha
        assert set(names)==set(expected)|{prefix+'SHA256SUMS'}, 'Unexpected ZIP members'
        for name,sha in expected.items(): assert digest(archive.read(name))==sha,name
        return {'zipEntries':len(names),'verifiedFiles':len(expected),'root':prefix[:-1]}
def package(target):
    version=json.loads((ROOT/'package.json').read_text())['version'];suffix=version
    prefix='qqqsp-v'+suffix+'/'
    files={}
    for p in sorted(ROOT.rglob('*')):
        rel=p.relative_to(ROOT)
        if any(part in EXCLUDE for part in rel.parts):continue
        if any(part.startswith('.') and part not in HIDDEN for part in rel.parts):continue
        if len(rel.parts)>1 and rel.parts[0] not in DIRECTORIES:continue
        if p.is_symlink():raise ValueError('Source symlinks are not packaged: '+str(rel))
        if not p.is_file() or rel.as_posix()=='SHA256SUMS' or p.suffix in {'.pyc','.zip','.tmp','.bak','.pem','.key'}:continue
        files[rel.as_posix()]=p.read_bytes()
    required=['server.js','app.js','package.json','VERSION','public/panel.bundle.js','public/index.html','部署说明.md']
    assert all(name in files for name in required),'Missing required source'
    manifest=''.join(f'{digest(data)}  {name}\n' for name,data in files.items())
    (ROOT/'SHA256SUMS').write_text(manifest)
    files['SHA256SUMS']=manifest.encode()
    target.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for name,data in sorted(files.items()):
            info=zipfile.ZipInfo(prefix+name,date_time=(2026,9,21,0,0,0));info.create_system=3
            info.external_attr=(stat.S_IFREG|(0o755 if name.endswith('.sh') else 0o644))<<16
            info.compress_type=zipfile.ZIP_DEFLATED;archive.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
    result=verify(target);result.update({'file':str(target),'bytes':target.stat().st_size,'sha256':digest(target.read_bytes()),'applicationVersion':version,'assetVersion':files['VERSION'].decode().strip()})
    Path(str(target)+'.sha256').write_text(result['sha256']+'  '+target.name+'\n')
    return result
if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--verify': print(json.dumps(verify(Path(sys.argv[2])),ensure_ascii=False,indent=2))
    elif len(sys.argv)==2: print(json.dumps(package(Path(sys.argv[1]).resolve()),ensure_ascii=False,indent=2))
    else: raise SystemExit(__doc__)
