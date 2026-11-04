"""Download to a private staged file using an existing lease key; never retry automatically."""
import argparse
import json

from canaveral.model import Error
from canaveral.sdk import LeaseClient


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',required=True)
    parser.add_argument('--ca-file',help='Optional PEM CA bundle for verified HTTPS.')
    parser.add_argument('--lease-id',required=True)
    parser.add_argument('--credential-file',required=True,help='Existing private lease key; no credential rotation.')
    parser.add_argument('--session-id',required=True,help='Persist this UUID before dispatch; inspect an uncertain attempt before opening another session.')
    parser.add_argument('--path',required=True,help='Guest file path.')
    parser.add_argument('--destination',required=True,help='Local file in an existing destination directory.')
    parser.add_argument('--member',default='primary')
    parser.add_argument('--app',help='App container identifier where required by the provider.')
    parser.add_argument('--replace',action='store_true',help='Explicitly permit replacing an existing local destination after verification.')
    args=parser.parse_args()
    try:
        lease=LeaseClient.from_credential_file(args.url,args.lease_id,args.credential_file,ca_file=args.ca_file)
        result=lease.download_to_file(args.session_id,args.member,args.path,args.destination,app=args.app,replace=args.replace)
    except Error as error:
        state='needs-inspection' if error.code in ('download_publication_uncertain','download_temporary_cleanup_failed') else 'incomplete'
        print(json.dumps({'sessionId':args.session_id,'state':state,'code':error.code,'requestId':error.request_id}))
        return 1
    except OSError:
        print(json.dumps({'sessionId':args.session_id,'state':'incomplete','code':'local_io_failed'}))
        return 1
    print(json.dumps({'sessionId':args.session_id,'state':'complete','bytes':result['bytes'],'sha256':result['sha256']}))
    return 0


if __name__=='__main__':raise SystemExit(main())
