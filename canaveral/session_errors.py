"""Bounded worker error semantics without forwarding provider messages or replaying."""
from .model import Error


WORKER_MESSAGES={
    'capability_unsupported':'This worker does not support the requested access capability. Inspect the session before choosing another environment.',
    'session_incomplete':'Access ended without confirmed completion. Inspect before retrying.',
    'upload_publication_uncertain':'Upload publication may have occurred. Inspect the destination before retrying.',
}


def worker_error(value,request_id=None):
    if not isinstance(value,dict) or value.get('type')!='error':return None
    if (set(value)!={'type','code','message','outcome'} or not isinstance(value.get('code'),str) or
        value['code'] not in WORKER_MESSAGES or not isinstance(value.get('message'),str) or value.get('outcome')!='unknown'):
        return Error('Invalid worker error control; completion was not confirmed.',409,code='session_protocol_error',
                     request_id=request_id,retryable=False,outcome='unknown')
    return Error(WORKER_MESSAGES[value['code']],409,code=value['code'],request_id=request_id,
                 retryable=False,outcome='unknown')


def checked(value,request_id=None):
    error=worker_error(value,request_id)
    if error:raise error
    return value
