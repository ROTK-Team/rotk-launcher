"""Bind the prepared installer and packaged attestation inputs to its exact source."""
import hashlib
import json
import os
from pathlib import Path

root = Path('release')
version = json.loads(Path('package.json').read_text())['version']
installer = f'ROTK-Launcher-{version}-x64.exe'
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
files = {name: digest(root / name) for name in (installer, installer + '.blockmap', 'latest.yml', 'SHA256SUMS.txt')}
patches = []
for name in ('steam_api64.dll', 'vivoxsdk_x64.dll', 'vivoxsdk_x64_v5.dll', 'dinput8.dll'):
    path = root / 'win-unpacked/resources/patches' / name
    sha = digest(path)
    if Path(str(path) + '.sha256').read_text().split()[0].lower() != sha:
        raise ValueError('Packaged attestation sidecar mismatch: ' + name)
    patches.append(dict(path=name, size=path.stat().st_size, sha256=sha))
(root / 'prepared-release.json').write_text(json.dumps(dict(
    revision=os.environ['GITHUB_SHA'], version=version, files=files,
    launcherOverrides=patches), indent=2), encoding='utf-8')
