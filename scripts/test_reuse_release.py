import copy
import hashlib
import json
from pathlib import Path
import tempfile
import os
import subprocess
import sys
import unittest
from urllib.request import HTTPRedirectHandler
import zipfile
import importlib.util

spec = importlib.util.spec_from_file_location('reuse', Path(__file__).with_name('reuse-release.py'))
reuse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reuse)
SHA = 'a' * 40

class ReuseReleaseTests(unittest.TestCase):
    def test_preparation_records_installed_dlls_and_rejects_stale_sidecars(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/'package.json').write_text('{"version":"2.0.33"}')
            patches=root/'release/win-unpacked/resources/patches'
            patches.mkdir(parents=True)
            for name in ('steam_api64.dll','vivoxsdk_x64.dll','vivoxsdk_x64_v5.dll','dinput8.dll'):
                (patches/name).write_bytes(b'installed including signature')
                (patches/(name+'.sha256')).write_text(hashlib.sha256(b'installed including signature').hexdigest())
            for name in ('ROTK-Launcher-2.0.33-x64.exe','ROTK-Launcher-2.0.33-x64.exe.blockmap','latest.yml','SHA256SUMS.txt'):
                (root/'release'/name).write_bytes(b'prepared')
            script=Path(__file__).with_name('record-prepared-release.py')
            def record():
                return subprocess.run([sys.executable,str(script)],cwd=root,env={**os.environ,'GITHUB_SHA':SHA},capture_output=True,text=True)
            self.assertEqual(record().returncode,0)
            proof=json.loads((root/'release/prepared-release.json').read_text())
            self.assertEqual(proof['revision'],SHA)
            self.assertEqual(len(proof['launcherOverrides']),4)
            (patches/'steam_api64.dll.sha256').write_text('0'*64)
            self.assertNotEqual(record().returncode,0)

    def test_only_latest_successful_exact_main_manual_run_is_eligible(self):
        row = dict(id=1, run_number=1, run_attempt=1, head_sha=SHA, head_branch='main',
                   event='workflow_dispatch', path=reuse.WORKFLOW, status='completed', conclusion='success',
                   repository={'full_name': reuse.REPO}, head_repository={'full_name': reuse.REPO})
        def select(rows):
            return reuse.select_run(dict(total_count=len(rows), workflow_runs=rows), SHA, 99)
        self.assertEqual(select([row]), row)
        for field,value in [('head_sha','b'*40),('head_branch','feature'),('event','pull_request'),
                            ('path','other.yml'),('id',99),('head_repository',{'full_name':'fork/repo'})]:
            with self.subTest(field=field):
                self.assertIsNone(select([{**row,field:value}]))
        self.assertIsNone(select([row,{**row,'id':2,'run_number':2,'conclusion':'failure'}]))
        with self.assertRaises(ValueError):
            reuse.select_run(dict(total_count=101,workflow_runs=[row]),SHA,99)

    def test_expired_ambiguous_or_unbound_artifacts_are_rejected(self):
        row=dict(name='rotk-launcher-release-'+SHA,expired=False,digest='sha256:'+'b'*64)
        def select(rows):
            return reuse.select_artifact(dict(total_count=len(rows),artifacts=rows),SHA)
        self.assertEqual(select([row]),row)
        self.assertIsNone(select([{**row,'expired':True}]))
        for rows in ([row,row],[{**row,'digest':None}]):
            with self.assertRaises(ValueError): select(rows)

    def test_token_is_not_forwarded_to_artifact_storage(self):
        request=reuse.request('/actions/artifacts/1/zip','test-secret')
        redirect=HTTPRedirectHandler().redirect_request(request,None,302,'Found',{},'https://storage.example/object')
        self.assertFalse(redirect.has_header('Authorization'))

    def test_archive_integrity_source_and_member_allowlist(self):
        version='2.0.33'
        exe='ROTK-Launcher-2.0.33-x64.exe'
        base={exe:b'installer',exe+'.blockmap':b'blocks','latest.yml':b'updater','SHA256SUMS.txt':b'checksums'}
        for failure in ('none','digest','source','hash','traversal','duplicate'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                entries=copy.deepcopy(base)
                metadata=dict(revision=SHA,version=version,files={k:hashlib.sha256(v).hexdigest() for k,v in entries.items()})
                if failure=='source': metadata['revision']='b'*40
                if failure=='hash': entries[exe]=b'wrong installer'
                entries['prepared-release.json']=json.dumps(metadata).encode()
                if failure=='traversal': entries['../evil']=b'bad'
                archive=Path(folder)/'artifact.zip'
                with zipfile.ZipFile(archive,'w') as bundle:
                    for name,data in entries.items(): bundle.writestr(name,data)
                    if failure=='duplicate': bundle.writestr(exe,b'duplicate')
                digest='0'*64 if failure=='digest' else reuse.sha256(archive)
                target=Path(folder)/'release'
                if failure=='none':
                    reuse.extract_verified(archive,target,digest,SHA,version)
                    self.assertEqual((target/exe).read_bytes(),b'installer')
                else:
                    with self.assertRaises(ValueError): reuse.extract_verified(archive,target,digest,SHA,version)
                self.assertFalse((Path(folder)/'evil').exists())

if __name__=='__main__': unittest.main()
