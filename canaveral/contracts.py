"""Packaged consumer HTTP contract; loading never contacts a controller."""
import json
from importlib import resources


def consumer_api_schema():
    return json.loads(resources.files('canaveral').joinpath('schemas/consumer-api.openapi.json').read_text(encoding='utf-8'))


def session_protocol_schema():
    return json.loads(resources.files('canaveral').joinpath('schemas/session-control.schema.json').read_text(encoding='utf-8'))
