#!/usr/bin/env python3
"""Build Android upload helpers with an already installed NDK; never deploy them."""
import argparse
import hashlib
import json
import os
import platform
import struct
import subprocess
import tempfile
from pathlib import Path


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ndk',required=True,type=Path)
    parser.add_argument('--output-dir',type=Path,default=Path('dist/android-transfer'))
    args=parser.parse_args()
    system={'Darwin':'darwin','Linux':'linux','Windows':'windows'}.get(platform.system())
    if not system:parser.error('Unsupported NDK build host.')
    prebuilt=args.ndk/'toolchains/llvm/prebuilt'/(system+'-x86_64')
    compiler=prebuilt/'bin'/('clang.exe' if system=='windows' else 'clang')
    if not compiler.is_file():parser.error('The configured installed NDK has no matching compiler.')
    source=Path(__file__).resolve().parents[1]/'canaveral/native/android_transfer.c'
    args.output_dir.mkdir(parents=True,exist_ok=True)
    manifest={'schemaVersion':1,'protocol':'CANAVERAL_TRANSFER_V1','minimumAPI':26,'artifacts':{}}
    with tempfile.TemporaryDirectory(dir=args.output_dir) as temporary:
        for arch,target,machine in [('arm64','aarch64-linux-android26',183),('amd64','x86_64-linux-android26',62)]:
            name='canaveral-transfer-'+arch;artifact=Path(temporary)/name
            subprocess.run([str(compiler),'--target='+target,'--sysroot='+str(prebuilt/'sysroot'),
                '-std=c11','-O2','-Wall','-Wextra','-Werror','-fPIE','-pie','-Wl,-z,relro,-z,now',str(source),'-o',str(artifact)],check=True)
            data=artifact.read_bytes()
            if data[:6]!=b'\x7fELF\x02\x01' or struct.unpack_from('<H',data,18)[0]!=machine:
                raise RuntimeError('Compiler produced an unexpected Android artifact.')
            if b'CANAVERAL_TRANSFER_TEST_FAIL' in data:raise RuntimeError('Test fault injection must not ship.')
            manifest['artifacts'][arch]={'file':name,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
            os.replace(artifact,args.output_dir/name)
    (args.output_dir/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest,indent=2))


if __name__=='__main__':main()
