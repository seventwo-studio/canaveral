"""Capture or control an existing lease through its scoped display session.

Requires the visual extra and an accepted lease-capable runner. This example does
not acquire machines, renew leases or retry input. Ordinary live runners remain gated.
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
    parser.add_argument('--credential-file',required=True,help='A private lease-scoped credential file; this example does not rotate keys.')
    parser.add_argument('--lease',required=True)
    parser.add_argument('--session-request-id',required=True,help='Use a new persisted session UUID; never reconnect an old generation.')
    parser.add_argument('--member',default='primary')
    parser.add_argument('--output',required=True,help='A new PNG path; existing files are not overwritten.')
    action=parser.add_mutually_exclusive_group()
    action.add_argument('--text',help='Explicitly take control and send a durable text action.')
    action.add_argument('--receipt-id',help='Inspect an uncertain action UUID without taking input control.')
    parser.add_argument('--action-id',help='Persist this UUID before sending --text; inspect its receipt after uncertainty.')
    args=parser.parse_args()
    if args.text is not None and not args.action_id:parser.error('--text requires --action-id')
    if args.action_id and args.text is None:parser.error('--action-id requires --text')
    output=Path(args.output)
    if output.exists():parser.error('--output must name a new file')
    lease=LeaseClient.from_credential_file(args.url,args.lease,args.credential_file,ca_file=args.ca_file)
    with lease.display(args.session_request_id,args.member) as display:
        outcome=None
        if args.text is not None:
            if display.take_control()!='owned':raise RuntimeError('Input ownership unavailable; no text was sent.')
            outcome=display.action(args.action_id,'text',{'text':args.text})
            display.release_control()
        elif args.receipt_id:outcome=display.receipt(args.receipt_id)
        capture=display.screenshot()
        with os.fdopen(os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as target:target.write(capture)
        report={'leaseId':lease.id,'width':display.width,'height':display.height,'screenshot':str(output)}
        if outcome:report['action']={'id':outcome['id'],'state':outcome['state']}
        print(json.dumps(report)) # Never print credentials or private provider bindings.
        return 0 if not outcome or outcome['state']=='succeeded' else 1


if __name__=='__main__':raise SystemExit(main())
