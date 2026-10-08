"""Reuse an immutable installer prepared by this workflow on the exact main SHA."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import zipfile

REPO = 'rotk-team/rotk-launcher'
WORKFLOW = '.github/workflows/release.yml'


def select_run(payload, sha, current):
    rows = payload['workflow_runs']
    if payload['total_count'] != len(rows):
        raise ValueError('Incomplete release run listing')
    rows = [r for r in rows if r.get('head_sha') == sha and r.get('head_branch') == 'main'
            and r.get('event') == 'workflow_dispatch' and r.get('path') == WORKFLOW
            and r.get('id') != current
            and r.get('repository', {}).get('full_name', '').lower() == REPO
            and r.get('head_repository', {}).get('full_name', '').lower() == REPO]
    if not rows:
        return None
    latest = max(rows, key=lambda r: (r['run_number'], r['run_attempt'], r['id']))
    return latest if latest.get('status') == 'completed' and latest.get('conclusion') == 'success' else None


def select_artifact(payload, sha):
    if payload['total_count'] != len(payload['artifacts']):
        raise ValueError('Incomplete artifact listing')
    rows = [a for a in payload['artifacts'] if a.get('name') == 'rotk-launcher-release-' + sha and a.get('expired') is False]
    if not rows:
        return None
    if len(rows) != 1 or not re.fullmatch(r'sha256:[0-9a-f]{64}', rows[0].get('digest') or ''):
        raise ValueError('Ambiguous artifact or absent GitHub digest')
    return rows[0]


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def extract_verified(archive, target, digest, sha, version):
    if sha256(archive) != digest.removeprefix('sha256:'):
        raise ValueError('GitHub artifact digest mismatch')
    installer = f'ROTK-Launcher-{version}-x64.exe'
    names = {installer, installer + '.blockmap', 'latest.yml', 'SHA256SUMS.txt', 'prepared-release.json'}
    with zipfile.ZipFile(archive) as bundle:
        if len(bundle.namelist()) != len(names) or set(bundle.namelist()) != names:
            raise ValueError('Unexpected artifact members')
        if sum(i.file_size for i in bundle.infolist()) > 1024**3:
            raise ValueError('Oversized release artifact')
        metadata = json.loads(bundle.read('prepared-release.json'))
        if metadata.get('revision') != sha or metadata.get('version') != version:
            raise ValueError('Prepared release source mismatch')
        if set(metadata.get('files', {})) != names - {'prepared-release.json'}:
            raise ValueError('Incomplete prepared file manifest')
        target.mkdir(parents=True, exist_ok=False)
        for name in names:
            with bundle.open(name) as source, (target / name).open('xb') as dest:
                while chunk := source.read(1024 * 1024):
                    dest.write(chunk)
        for name, expected in metadata['files'].items():
            if sha256(target / name) != expected:
                raise ValueError('Prepared file hash mismatch: ' + name)


def request(path, token):
    req = Request('https://api.github.com/repos/' + REPO + path,
                  headers={'Accept': 'application/vnd.github+json'})
    req.add_unredirected_header('Authorization', 'Bearer ' + token)
    return req


def main():
    sha = os.environ['GITHUB_SHA']
    if os.environ.get('GITHUB_REPOSITORY', '').lower() != REPO or not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('Expected repository and exact SHA required')
    version = json.loads(Path('package.json').read_text())['version']
    token = os.environ['GH_TOKEN']
    def api(path):
        with urlopen(request(path, token), timeout=30) as response:
            return json.load(response)
    query = urlencode(dict(head_sha=sha, branch='main', event='workflow_dispatch', per_page=100))
    run = select_run(api('/actions/workflows/release.yml/runs?' + query), sha, int(os.environ['GITHUB_RUN_ID']))
    artifact = select_artifact(api(f"/actions/runs/{run['id']}/artifacts?per_page=100"), sha) if run else None
    if artifact:
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'prepared.zip'
            total = 0
            with urlopen(request(f"/actions/artifacts/{artifact['id']}/zip", token), timeout=60) as source, archive.open('xb') as dest:
                while chunk := source.read(1024 * 1024):
                    total += len(chunk)
                    if total > 1024**3:
                        raise ValueError('Artifact download exceeded limit')
                    dest.write(chunk)
            if total != artifact['size_in_bytes']:
                raise ValueError('Artifact size mismatch')
            extract_verified(archive, Path('release'), artifact['digest'], sha, version)
        print(f"Reusing exact main installer from run {run['id']} / artifact {artifact['id']}")
    else:
        print('No successful exact-main prebuild exists; normal packaging is required.')
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        output.write('reused=' + str(bool(artifact)).lower() + '\n')


if __name__ == '__main__':
    main()
