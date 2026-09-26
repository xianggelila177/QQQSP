"""Compatibility entry point; all source releases use package.py's whitelist."""
from pathlib import Path
import json
import sys
from package import main

if __name__=='__main__':
    args=sys.argv[1:]
    if not args:
        root=Path(__file__).resolve().parents[1]
        version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
        args=[str(root.parent/f'qqqsp-v{version}-source.zip')]
    main(args)
