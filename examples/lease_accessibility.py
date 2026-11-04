"""Read a native accessibility snapshot from an existing lease into a private file.

Requires an accepted lease-capable runner. No machine acquisition, input ownership,
UI action, credential rotation or automatic retry occurs in this example.
"""
import argparse
import json
import os
from pathlib import Path

from canaveral.sdk import LeaseClient


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',required=True)
    parser.add_argument('--ca-file',help='Optional PEM CA bundle for verified HTTPS.')
    parser.add_argument('--credential-file',required=True,help='Private lease-scoped credential file.')
    parser.add_argument('--lease',required=True)
    parser.add_argument('--request-id',required=True,help='A new persisted session UUID for this inspection.')
    parser.add_argument('--member',default='primary')
    parser.add_argument('--output',required=True,help='New private JSON file; existing files are not overwritten.')
    args=parser.parse_args();output=Path(args.output)
    if output.exists():parser.error('--output must name a new file')
    lease=LeaseClient.from_credential_file(args.url,args.lease,args.credential_file,ca_file=args.ca_file)
    value=lease.accessibility(args.request_id,args.member)
    with os.fdopen(os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as target:
        json.dump(value,target,ensure_ascii=False,allow_nan=False,indent=2)
    print(json.dumps({'snapshotId':value['snapshotId'],'nodes':len(value['nodes']),'truncated':value['truncated'],'output':str(output)}))


if __name__=='__main__':main()
