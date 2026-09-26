"""Package the checked source with Python stdlib; do not run legacy release.mjs.
Usage: python3 scripts/package.py /path/to/qqqsp-source.zip
       python3 scripts/package.py --verify /path/to/qqqsp-source.zip
Run build, check and relevant regression tests before packaging.
"""
from pathlib import Path, PurePosixPath
import hashlib, json, stat, sys, zipfile
ROOT=Path(__file__).resolve().parents[1]
DIRECTORIES={'lib','public','data','ops','docs','scripts','tests'}
EXCLUDE={'node_modules','.git','__pycache__','logs','state','dist','.pytest_cache',
         'private','outputs','work','recovery','coverage','playwright-report','test-results','evidence'}
HIDDEN={'.env.example','.gitignore','.dockerignore','.gitattributes'}
EXTENSIONS={'.js','.mjs','.json','.html','.css','.svg','.webmanifest','.md','.txt',
            '.sh','.py','.service','.timer','.conf','.yaml','.yml','.xml','.raw','.gz','.br'}

def public_source(relative):
    p=PurePosixPath(relative)
    if p.is_absolute() or '..' in p.parts or '\\' in relative:return False
    if any(part.lower() in EXCLUDE for part in p.parts):return False
    if any(part.startswith('.') and part not in HIDDEN for part in p.parts):return False
    if len(p.parts)>1 and p.parts[0] not in DIRECTORIES:return False
    if p.name.endswith('.env') or p.name.startswith('.env.') and p.name!='.env.example':return False
    return p.name in HIDDEN or p.name in {'VERSION','Dockerfile','SHA256SUMS'} or p.suffix in EXTENSIONS

def source_bytes(p):
    data=p.read_bytes()
    if p.suffix=='.sh' and b'\r' in data:raise ValueError('Shell source must use LF: '+p.name)
    return data
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
            assert public_source(name[len(prefix):]), 'Private or unsupported archive entry: '+name
            if name.endswith('.sh'):assert b'\r' not in archive.read(name), 'Shell archive entry must use LF: '+name
        manifest=archive.read(prefix+'SHA256SUMS').decode().splitlines()
        expected={}
        for line in manifest:
            sha,relative=line.split('  ',1);expected[prefix+relative]=sha
        assert set(names)==set(expected)|{prefix+'SHA256SUMS'}, 'Unexpected ZIP members'
        for name,sha in expected.items(): assert digest(archive.read(name))==sha,name
        return {'zipEntries':len(names),'verifiedFiles':len(expected),'root':prefix[:-1]}
def package(target):
    version=json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version'];suffix=version
    prefix='qqqsp-v'+suffix+'/'
    files={}
    for p in sorted(ROOT.rglob('*')):
        rel=p.relative_to(ROOT)
        if not public_source(rel.as_posix()):continue
        if p.is_symlink():raise ValueError('Source symlinks are not packaged: '+str(rel))
        if not p.is_file() or rel.as_posix()=='SHA256SUMS' or p.suffix in {'.pyc','.zip','.tmp','.bak','.pem','.key'}:continue
        files[rel.as_posix()]=source_bytes(p)
    required=['server.js','app.js','package.json','VERSION','public/panel.bundle.js','public/index.html','部署说明.md']
    assert all(name in files for name in required),'Missing required source'
    manifest=''.join(f'{digest(data)}  {name}\n' for name,data in files.items())
    (ROOT/'SHA256SUMS').write_bytes(manifest.encode('utf-8'))
    files['SHA256SUMS']=manifest.encode()
    target.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for name,data in sorted(files.items()):
            info=zipfile.ZipInfo(prefix+name,date_time=(2026,9,21,0,0,0));info.create_system=3
            info.external_attr=(stat.S_IFREG|(0o755 if name.endswith('.sh') else 0o644))<<16
            info.compress_type=zipfile.ZIP_DEFLATED;archive.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
    result=verify(target);result.update({'file':str(target),'bytes':target.stat().st_size,'sha256':digest(target.read_bytes()),'applicationVersion':version,'assetVersion':files['VERSION'].decode().strip()})
    Path(str(target)+'.sha256').write_bytes((result['sha256']+'  '+target.name+'\n').encode('utf-8'))
    return result
def main(args=None):
    args=list(sys.argv[1:] if args is None else args)
    if len(args)==2 and args[0]=='--verify':result=verify(Path(args[1]))
    elif len(args)==1:result=package(Path(args[0]).resolve())
    else:raise SystemExit(__doc__)
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
