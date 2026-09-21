"""Create a complete source archive without private configuration, caches or dependencies."""
from pathlib import Path
import hashlib, json, sys, zipfile
ROOT=Path(__file__).resolve().parents[1]
version=json.loads((ROOT/'package.json').read_text())['version']
output=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else ROOT.parent/f'qqqsp-v{version}-source.zip'
blocked={'.git','node_modules','state','logs','coverage','__pycache__','.verification','playwright-report','test-results'}
files=[]
for item in sorted(ROOT.rglob('*')):
    relative=item.relative_to(ROOT)
    if not item.is_file() or item.is_symlink() or any(part in blocked for part in relative.parts):continue
    if item.name.startswith('.env') and item.name!='.env.example':continue
    if item.suffix in {'.zip','.patch','.pem','.key','.p12','.pfx','.pyc'} or item==output:continue
    files.append((item,relative))
output.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
    for item,relative in files:archive.write(item,str(Path(f'qqqsp-v{version}')/relative))
print(json.dumps({'path':str(output),'files':len(files),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()},indent=2))
