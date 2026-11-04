"""Submit or inspect a durable guest operation with an existing scoped lease key."""
import argparse
import json

from canaveral.model import Error
from canaveral.sdk import LeaseClient


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',required=True)
    parser.add_argument('--ca-file',help='PEM CA bundle for verified HTTPS.')
    parser.add_argument('--lease-id',required=True)
    parser.add_argument('--credential-file',required=True,help='Private existing lease key; no rotation.')
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--request-file',help='Persisted JSON object containing id, member, action and arguments.')
    mode.add_argument('--operation-id',help='Inspect this previously persisted operation UUID.')
    args=parser.parse_args()
    try:
        lease=LeaseClient.from_credential_file(args.url,args.lease_id,args.credential_file,ca_file=args.ca_file)
        if args.request_file:
            with open(args.request_file,encoding='utf-8') as source:raw=source.read(1048577)
            if len(raw)>1048576:raise Error('Operation request file exceeds its envelope.',400)
            request=json.loads(raw)
            if not isinstance(request,dict) or set(request)!={'id','member','action','arguments'}:
                raise Error('Invalid operation request file.',400)
            result=lease.create_operation(request['id'],request['member'],request['action'],request['arguments'])
        else:
            result=lease.operation(args.operation_id)
    except Error as error:
        print(json.dumps({'state':'needs-inspection' if error.outcome=='unknown' else 'incomplete',
                          'code':error.code,'requestId':error.request_id}))
        return 1
    except (OSError,ValueError):
        print(json.dumps({'state':'incomplete','code':'request_file_failed'}))
        return 1
    # Guest output can contain secrets. Report receipt metadata only.
    print(json.dumps({key:result[key] for key in ('id','leaseId','member','state','updatedAt')}))
    return 0


if __name__=='__main__':raise SystemExit(main())
