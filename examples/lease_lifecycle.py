"""Acquire/inspect/release using a private application credential and stable UUID.

Requires a runner with implemented lease protocol 1. Current administrative runners
do not yet advertise it. This example does not imply guest-access or cleanup acceptance.
"""
import argparse
import json
import uuid

from canaveral.sdk import ConsumerClient


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',required=True)
    parser.add_argument('--ca-file',help='Optional PEM CA bundle for verified HTTPS.')
    parser.add_argument('--credential-file',required=True)
    parser.add_argument('--request-id',required=True,help='Persist this UUID and reuse it for the same acquisition after uncertain responses.')
    parser.add_argument('--image',required=True)
    parser.add_argument('--revision',required=True)
    parser.add_argument('--arch',required=True,choices=['arm64','amd64'])
    args=parser.parse_args()
    consumer=ConsumerClient.from_credential_file(args.url,args.credential_file,ca_file=args.ca_file)
    lease=consumer.acquire(args.request_id,args.image,args.revision,args.arch,ttl_seconds=60)
    print(json.dumps(lease,indent=2))
    if lease['state'] not in ('provisioning','ready'):return
    # Rotation exchanges the application credential for a key limited to this lease.
    release=str(uuid.uuid5(uuid.UUID(args.request_id),'example-release'))
    try:
        scoped=consumer.scoped_lease(lease['id'])
        print(json.dumps(scoped.inspect(),indent=2))
    finally:
        print(json.dumps(consumer.release(lease['id'],release),indent=2))


if __name__=='__main__':main()
