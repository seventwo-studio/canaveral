"""Windows UI Automation worker; not an enrolled guest service or host adapter.

Native COM runs only through native_api() on Windows. A guest service must run
each worker in its own bounded-lifetime process, bind the inspection to its
session/boot and serialize input with display ownership before dispatch.
"""
import contextlib
import json
import math
import sys
import threading
import time
import uuid

from canaveral.inspection_protocol import MAX_BYTES, validate_snapshot
from canaveral.lease_clock import execution_monotonic
from canaveral.model import Error


FIELDS = ('role', 'name', 'identifier', 'states', 'actions', 'bounds', 'properties')


def _label(value, maximum=1024):
    if value is None:
        return ''
    if not isinstance(value, str):
        raise ValueError('Invalid UI Automation label')
    return value[:maximum]


def _runtime_id(value):
    result = list(value)
    if not 1 <= len(result) <= 64 or any(type(n) is not int or not -(2**31) <= n < 2**31 for n in result):
        raise ValueError('Invalid UI Automation runtime identity')
    return result


class WindowsUIAutomation:
    def __init__(self, automation, definitions):
        self.automation, self.definitions = automation, definitions
        self.walker = automation.ControlViewWalker

    def root(self):
        return self.automation.GetRootElement()

    def first_child(self, element):
        return self.walker.GetFirstChildElement(element)

    def next_sibling(self, element):
        return self.walker.GetNextSiblingElement(element)

    def same(self, first, second):
        return bool(self.automation.CompareElements(first, second))

    def describe(self, element):
        runtime = _runtime_id(element.GetRuntimeId())
        protected = bool(element.CurrentIsPassword)
        rectangle = element.CurrentBoundingRectangle
        coordinates = [rectangle.left, rectangle.top, rectangle.right, rectangle.bottom]
        if any(type(n) not in (int, float) or not math.isfinite(n) for n in coordinates):
            raise ValueError('Invalid UI Automation bounds')
        left, top, right, bottom = coordinates
        if right < left or bottom < top:
            raise ValueError('Invalid UI Automation bounds')
        enabled = bool(element.CurrentIsEnabled)
        offscreen = bool(element.CurrentIsOffscreen)
        invokable = bool(element.GetCurrentPropertyValue(
            self.definitions.UIA_IsInvokePatternAvailablePropertyId))
        properties = {'runtimeId': runtime, 'processId': int(element.CurrentProcessId),
            'controlTypeId': int(element.CurrentControlType),
            'className': _label(element.CurrentClassName),
            'frameworkId': _label(element.CurrentFrameworkId),
            'helpText': '' if protected else _label(element.CurrentHelpText),
            'acceleratorKey': _label(element.CurrentAcceleratorKey),
            'accessKey': _label(element.CurrentAccessKey)}
        # Never query Value/Text patterns for protected controls. A label can
        # also contain a misbehaving provider's password value, so redact it.
        if not protected and bool(element.GetCurrentPropertyValue(
                self.definitions.UIA_IsValuePatternAvailablePropertyId)):
            pattern = element.GetCurrentPattern(self.definitions.UIA_ValuePatternId)
            value = pattern.QueryInterface(self.definitions.IUIAutomationValuePattern)
            properties['value'] = _label(value.CurrentValue, 4096)
            properties['readOnly'] = bool(value.CurrentIsReadOnly)
        return {'role': _label(element.CurrentLocalizedControlType),
            'name': '' if protected else _label(element.CurrentName),
            'identifier': _label(element.CurrentAutomationId),
            'states': {'enabled': enabled, 'focused': bool(element.CurrentHasKeyboardFocus),
                       'focusable': bool(element.CurrentIsKeyboardFocusable),
                       'offscreen': offscreen, 'password': protected},
            'bounds': {'x': left, 'y': top, 'width': right-left, 'height': bottom-top},
            'actions': ['invoke'] if invokable and enabled and not offscreen and not protected
                       and right > left and bottom > top else [],
            'properties': properties}

    def invoke(self, element):
        pattern = element.GetCurrentPattern(self.definitions.UIA_InvokePatternId)
        invoke = pattern.QueryInterface(self.definitions.IUIAutomationInvokePattern)
        invoke.Invoke()


@contextlib.contextmanager
def native_api():
    if sys.platform != 'win32':
        raise Error('Windows UI Automation requires an owned Windows guest worker.', 409,
                    code='capability_unsupported')
    # This entry point belongs to a fresh worker process, never an HTTP thread.
    # UIA clients use a dedicated MTA; comtypes initializes on first import.
    if 'comtypes' in sys.modules:
        raise Error('Windows UI Automation requires a fresh worker process.', 409)
    sys.coinit_flags = 0  # COINIT_MULTITHREADED
    import ctypes
    from ctypes import wintypes
    from comtypes import CLSCTX_INPROC_SERVER
    from comtypes.client import CreateObject, GetModule
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetSystemDirectoryW.argtypes = [wintypes.LPWSTR, wintypes.UINT]
    kernel.GetSystemDirectoryW.restype = wintypes.UINT
    directory = ctypes.create_unicode_buffer(32768)
    length = kernel.GetSystemDirectoryW(directory, len(directory))
    if not 0 < length < len(directory):
        raise Error('Windows UI Automation system library is unavailable.', 503)
    definitions = GetModule(directory.value + '\\UIAutomationCore.dll')
    user = ctypes.WinDLL('user32', use_last_error=True)
    user.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    previous = user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
    if not previous:
        raise Error('Windows worker cannot establish physical screen coordinates.', 503)
    try:
        automation = CreateObject(definitions.CUIAutomation,
            interface=definitions.IUIAutomation, clsctx=CLSCTX_INPROC_SERVER)
        yield WindowsUIAutomation(automation, definitions)
    finally:
        user.SetThreadDpiAwarenessContext(previous)


def capture(api, clock=execution_monotonic, retained=None):
    nodes, seen = [], set()
    truncated, unavailable, size = False, 0, 1024
    deadline = clock() + 3

    def walk(element, path, parent=None):
        nonlocal truncated, unavailable, size
        if len(nodes) >= 1500 or len(path) > 25 or clock() >= deadline:
            truncated = True
            return False
        try:
            details = api.describe(element)
            runtime = tuple(_runtime_id(details['properties']['runtimeId']))
            if runtime in seen:
                unavailable += 1
                truncated = True
                return False
            seen.add(runtime)
            node = dict(id='ax-'+str(len(nodes)+1), parentId=parent, depth=len(path),
                        path=path, **details)
            encoded = json.dumps(node, ensure_ascii=False, allow_nan=False).encode('utf-8')
            if size + len(encoded) + 2 > MAX_BYTES:
                truncated = True
                return False
            size += len(encoded) + 2
            nodes.append(node)
            if retained is not None:
                retained[node['id']] = element
            if details['states'].get('password') is True:
                return True  # Protected descendants must not disclose values.
            child, index = api.first_child(element), 0
            while child:
                if not walk(child, path+[index], node['id']):
                    return False
                if clock() >= deadline:
                    truncated = True
                    return False
                child, index = api.next_sibling(child), index+1
            return True
        except Exception:
            unavailable += 1
            truncated = True
            return True  # Other sibling providers may remain accessible.

    walk(api.root(), [])
    if not nodes:
        raise Error('Windows native accessibility root is unavailable.', 503)
    return validate_snapshot({'snapshotId': str(uuid.uuid4()), 'capturedAt': time.time(),
        'source': 'windows-uia', 'coordinateSpace': 'screen-pixels', 'nodes': nodes,
        'truncated': truncated, 'unavailableNodes': unavailable,
        'coverage': 'Native UI Automation control view; protected content and descendants are omitted. '
                    'Custom-rendered, elevated, secure-desktop or inaccessible controls may be absent; '
                    'missing controls do not imply an empty desktop.'})


def perform(request, api, clock=execution_monotonic, *, elements=None):
    """42: refused before invocation; 43: invocation outcome is unconfirmed."""
    try:
        if not isinstance(elements, dict):
            raise ValueError('UI Automation handles must remain in the inspected worker')
        if not isinstance(request, dict) or set(request) != {'chain', 'action', 'startedAt', 'expiresAt'}:
            raise ValueError('Invalid UI Automation action context')
        start, end = request['startedAt'], request['expiresAt']
        if (any(type(n) not in (int, float) or not math.isfinite(n) for n in (start, end))
                or start < 0 or not 0 < end-start <= 15):
            raise ValueError('Invalid UI Automation action lifetime')
        def fresh():
            if not start <= clock() < end:
                raise ValueError('Expired UI Automation action context')
        fresh()
        chain = request['chain']
        if request['action'] != 'invoke' or not isinstance(chain, list) or not 1 <= len(chain) <= 26:
            raise ValueError('Invalid UI Automation action')
        target, previous, identities = api.root(), [], set()
        for index, node in enumerate(chain):
            fresh()
            path = node['path']
            if (not isinstance(path, list) or any(type(n) is not int or not 0 <= n < 1500 for n in path)
                    or (path != [] if index == 0 else len(path) != len(previous)+1 or path[:-1] != previous)
                    or node['parentId'] != (None if index == 0 else chain[index-1]['id'])
                    or node['depth'] != index or node['id'] in identities):
                raise ValueError('Incomplete UI Automation parent chain')
            identities.add(node['id'])
            if index:
                target = api.first_child(target)
                for _ in range(path[-1]):
                    fresh()
                    if not target:
                        raise ValueError('UI Automation target disappeared')
                    target = api.next_sibling(target)
            if not target or api.describe(target) != {key: node[key] for key in FIELDS}:
                raise ValueError('UI Automation target changed')
            original = elements[node['id']]
            if not api.same(target, original) or api.describe(original) != {key: node[key] for key in FIELDS}:
                raise ValueError('UI Automation retained target changed')
            target = original
            previous = path
        if ('invoke' not in node['actions'] or node['states'].get('enabled') is not True
                or node['states'].get('offscreen') is not False or node['states'].get('password') is not False
                or not node['bounds'] or node['bounds']['width'] <= 0 or node['bounds']['height'] <= 0):
            raise ValueError('UI Automation target cannot be invoked')
        fresh()
    except Exception:
        return 42
    try:
        api.invoke(target)
        return 0
    except Exception:
        return 43


class WindowsInspections:
    """One fresh snapshot and its live COM handles in a single owned worker."""
    def __init__(self, api, clock=execution_monotonic):
        self.api, self.clock = api, clock
        self.owner = threading.get_ident()
        self.value, self.elements, self.started = None, {}, None

    def _owned_thread(self):
        if threading.get_ident() != self.owner:
            raise Error('UI Automation handles cannot leave their inspection worker.', 409)

    def inspect(self):
        self._owned_thread()
        self.value, self.elements, self.started = None, {}, self.clock()
        try:
            value = capture(self.api, self.clock, self.elements)
            if not self.started <= self.clock() < self.started+15:
                raise Error('Windows inspection expired before acknowledgement.', 409)
        except Exception:
            self.elements = {}
            raise
        self.value = value
        return json.loads(json.dumps(value))

    def invoke(self, request):
        self._owned_thread()
        value, elements = self.value, self.elements
        # Consume before revalidation/dispatch. An uncertain effect is never
        # replayed and a new capture invalidates the previous target handles.
        self.value, self.elements = None, {}
        if (not isinstance(request, dict) or set(request) != {'snapshotId', 'nodeId', 'nativeAction'}
                or any(not isinstance(request[key], str) for key in request)
                or value is None or request['snapshotId'] != value['snapshotId']):
            raise Error('Windows accessibility target is stale; inspect again.', 409, code='input_rejected')
        by_id = {node['id']: node for node in value['nodes']}
        chain, current = [], request['nodeId']
        while current in by_id:
            node = by_id[current]
            chain.append(node)
            current = node['parentId']
        if not chain or current is not None:
            raise Error('Windows accessibility target is missing.', 409, code='input_rejected')
        result = perform({'chain': list(reversed(chain)), 'action': request['nativeAction'],
            'startedAt': self.started, 'expiresAt': math.nextafter(self.started+15, self.started)}, self.api, self.clock,
            elements=elements)
        if result == 42:
            raise Error('Windows accessibility target changed; inspect again.', 409, code='input_rejected')
        if result != 0:
            raise Error('Windows native invocation was not confirmed; inspect before another action.',
                        409, retryable=False, outcome='unknown')
        return {'status': 'posted'}


def main():
    try:
        if len(sys.argv) != 2 or sys.argv[1] != 'capture':
            return 42
        with native_api() as api:
            print(json.dumps(capture(api), ensure_ascii=False, allow_nan=False))
            return 0
    except Exception:
        return 42


if __name__ == '__main__':
    sys.exit(main())
