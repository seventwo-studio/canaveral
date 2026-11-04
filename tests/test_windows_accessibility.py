"""UIA-shaped doubles exercise contracts, never Windows COM or a desktop."""
import json
import math
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from canaveral.guest.windows_accessibility import WindowsUIAutomation, WindowsInspections, capture, native_api, perform
from canaveral.inspection_protocol import validate_snapshot
from canaveral.model import Error


DEFINITIONS = SimpleNamespace(UIA_IsInvokePatternAvailablePropertyId=1,
    UIA_IsValuePatternAvailablePropertyId=2, UIA_ValuePatternId=3, UIA_InvokePatternId=4,
    IUIAutomationValuePattern='value-interface', IUIAutomationInvokePattern='invoke-interface')


class Element:
    def __init__(self, identity, name='Control', children=()):
        self.identity, self.children = identity, list(children)
        for child in self.children:
            child.parent = self
        self.parent = None
        self.CurrentName = name
        self.CurrentIsPassword = False
        self.CurrentIsEnabled = True
        self.CurrentIsOffscreen = False
        self.CurrentHasKeyboardFocus = False
        self.CurrentIsKeyboardFocusable = True
        self.CurrentBoundingRectangle = SimpleNamespace(left=-20, top=30, right=100, bottom=70)
        self.CurrentProcessId = 42
        self.CurrentControlType = 50000
        self.CurrentClassName = 'NativeButton'
        self.CurrentFrameworkId = 'fixture'
        self.CurrentHelpText = 'Fixture description'
        self.CurrentAcceleratorKey = 'Ctrl+S'
        self.CurrentAccessKey = 'Alt+S'
        self.CurrentLocalizedControlType = 'button'
        self.CurrentAutomationId = 'save'
        self.CurrentValue, self.CurrentIsReadOnly = 'fixture value', False
        self.invokable, self.valued = True, False
        self.invocations, self.patterns = 0, []
        self.invoke_failure = False

    def GetRuntimeId(self):
        return self.identity

    def GetCurrentPropertyValue(self, property_id):
        return self.invokable if property_id == 1 else self.valued

    def GetCurrentPattern(self, pattern):
        self.patterns.append(pattern)
        return self

    def QueryInterface(self, interface):
        return self

    def Invoke(self):
        self.invocations += 1
        if self.invoke_failure:
            raise OSError('provider failed after possible effect')


class Walker:
    def GetFirstChildElement(self, element):
        return element.children[0] if element.children else None

    def GetNextSiblingElement(self, element):
        siblings = element.parent.children
        index = siblings.index(element)+1
        return siblings[index] if index < len(siblings) else None


class WindowsAccessibilityTests(unittest.TestCase):
    def setUp(self):
        self.button = Element([42, 5], 'Save')
        self.window = Element([42, 4], 'Editor', [self.button])
        self.root = Element([42, 3], 'Desktop', [self.window])
        self.api = WindowsUIAutomation(SimpleNamespace(ControlViewWalker=Walker(),
            GetRootElement=lambda: self.root, CompareElements=lambda a,b: a is b), DEFINITIONS)

    def snapshot(self):
        self.elements = {}
        return capture(self.api, clock=lambda: 100, retained=self.elements)

    def act(self, request, api, clock):
        return perform(request, api, clock, elements=self.elements)

    def request(self):
        return {'chain': self.snapshot()['nodes'], 'action': 'invoke',
                'startedAt': 100, 'expiresAt': 115}

    def test_native_properties_have_shared_shape_physical_bounds_and_opaque_ids(self):
        value = self.snapshot()
        self.assertEqual(validate_snapshot(value), value)
        self.assertEqual(value['source'], 'windows-uia')
        self.assertEqual(value['coordinateSpace'], 'screen-pixels')
        self.assertEqual([n['path'] for n in value['nodes']], [[], [0], [0, 0]])
        node = value['nodes'][-1]
        self.assertEqual(node['parentId'], value['nodes'][-2]['id'])
        self.assertEqual(node['properties']['runtimeId'], [42, 5])
        self.assertEqual(node['properties']['processId'], 42)
        self.assertEqual(node['bounds'], {'x': -20, 'y': 30, 'width': 120, 'height': 40})
        self.assertEqual(node['actions'], ['invoke'])
        self.assertNotIn('frame', value)

    def test_snapshot_matches_packaged_accessibility_schema(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest('Install contract test dependencies for JSON Schema validation')
        from canaveral.inspection_protocol import snapshot_schema
        jsonschema.validate(self.snapshot(), snapshot_schema())

    def test_protected_controls_never_query_value_or_expose_name_or_help(self):
        self.button.CurrentIsPassword = self.button.valued = True
        self.button.CurrentName = self.button.CurrentValue = self.button.CurrentHelpText = 'PASSWORD_SECRET'
        secret_child = Element([42, 200], 'PASSWORD_SECRET_CHILD')
        self.button.children = [secret_child]
        secret_child.parent = self.button
        value = self.snapshot()
        self.assertNotIn('PASSWORD_SECRET', json.dumps(value))
        self.assertEqual(self.button.patterns, [])
        self.assertEqual(value['nodes'][-1]['actions'], [])

    def test_disabled_or_replaced_pattern_never_falls_back_to_coordinate_input(self):
        request = self.request()
        self.button.invokable = False
        self.assertEqual(self.act(request, self.api, clock=lambda: 101), 42)
        self.assertEqual(self.button.invocations, 0)

    def test_nonprotected_value_and_read_only_state_are_available_and_bounded(self):
        self.button.valued = self.button.CurrentIsReadOnly = True
        self.button.CurrentValue = 'x' * 8000
        node = self.snapshot()['nodes'][-1]
        self.assertEqual(len(node['properties']['value']), 4096)
        self.assertTrue(node['properties']['readOnly'])

    def test_absent_optional_native_labels_remain_empty_instead_of_hiding_control(self):
        self.button.CurrentName = self.button.CurrentHelpText = self.button.CurrentAccessKey = None
        node = self.snapshot()['nodes'][-1]
        self.assertEqual(node['name'], '')
        self.assertEqual(node['properties']['helpText'], '')
        self.assertEqual(node['properties']['accessKey'], '')
        self.assertEqual(node['identifier'], 'save')

    def test_invocation_revalidates_complete_parent_chain(self):
        self.assertEqual(self.act(self.request(), self.api, clock=lambda: 101), 0)
        self.assertEqual(self.button.invocations, 1)
        self.assertEqual(self.button.patterns, [4])

    def test_changes_to_target_or_ancestors_refuse_before_effects(self):
        changes = [('CurrentName', 'Changed'), ('CurrentAutomationId', 'new-id'),
                   ('CurrentIsEnabled', False), ('CurrentIsOffscreen', True),
                   ('CurrentIsPassword', True), ('identity', [42, 99]),
                   ('CurrentBoundingRectangle', SimpleNamespace(left=0, top=0, right=5, bottom=5))]
        for owner in (self.button, self.window, self.root):
            for attribute, changed in changes:
                request = self.request()
                original = getattr(owner, attribute)
                setattr(owner, attribute, changed)
                with self.subTest(owner=owner.CurrentName, attribute=attribute):
                    self.assertEqual(self.act(request, self.api, clock=lambda: 101), 42)
                setattr(owner, attribute, original)
        self.assertEqual(self.button.invocations, 0)

    def test_sibling_replacement_and_missing_intermediate_parent_are_stale(self):
        request = self.request()
        self.window.children.insert(0, Element([42, 17], 'Other'))
        self.assertEqual(self.act(request, self.api, clock=lambda: 101), 42)
        self.window.children.pop(0)
        request['chain'].pop(1)
        self.assertEqual(self.act(request, self.api, clock=lambda: 101), 42)
        self.assertEqual(self.button.invocations, 0)

    def test_expiry_backward_clock_and_invalid_context_never_invoke(self):
        for now in (99, 115, 1000, float('inf')):
            self.assertEqual(self.act(self.request(), self.api, clock=lambda: now), 42)
        for update in ({'action': 'click'}, {'startedAt': float('nan')}, {'expiresAt': 116},
                       {'expiresAt': 100}, {'chain': []}, {'untrusted': True}):
            self.assertEqual(self.act({**self.request(), **update}, self.api, clock=lambda: 101), 42)
        self.assertEqual(self.button.invocations, 0)

    def test_timeout_during_revalidation_is_checked_again_before_invocation(self):
        request = self.request()
        now = [100]
        original = self.api.describe
        def delayed(element):
            result = original(element)
            if element is self.button:
                now[0] = 116
            return result
        self.api.describe = delayed
        self.assertEqual(self.act(request, self.api, clock=lambda: now[0]), 42)
        self.assertEqual(self.button.invocations, 0)

    def test_invocation_exception_is_uncertain_and_is_never_replayed(self):
        self.button.invoke_failure = True
        self.assertEqual(self.act(self.request(), self.api, clock=lambda: 101), 43)
        self.assertEqual(self.button.invocations, 1)

    def test_disabled_offscreen_or_zero_area_nodes_have_no_valid_action(self):
        for attribute, value in [('CurrentIsEnabled', False), ('CurrentIsOffscreen', True),
                                 ('CurrentBoundingRectangle', SimpleNamespace(left=0, top=0, right=0, bottom=0))]:
            original = getattr(self.button, attribute)
            setattr(self.button, attribute, value)
            self.assertEqual(self.act(self.request(), self.api, clock=lambda: 101), 42)
            setattr(self.button, attribute, original)
        self.assertEqual(self.button.invocations, 0)

    def test_cycles_duplicates_and_provider_failures_report_partial_coverage(self):
        self.button.identity = self.window.identity
        value = self.snapshot()
        self.assertTrue(value['truncated'])
        self.assertEqual(value['unavailableNodes'], 1)
        self.assertEqual(len(value['nodes']), 2)
        self.root.identity = []
        with self.assertRaises(Error):
            self.snapshot()

    def test_unavailable_control_does_not_hide_a_following_usable_sibling(self):
        bad = Element([42, 201], 'Unavailable')
        bad.CurrentBoundingRectangle = None
        bad.parent = self.window
        self.window.children.insert(0, bad)
        value = self.snapshot()
        self.assertTrue(value['truncated'])
        self.assertEqual(value['unavailableNodes'], 1)
        self.assertEqual(value['nodes'][-1]['name'], 'Save')
        self.assertEqual(value['nodes'][-1]['path'], [0, 1])

    def test_node_depth_and_byte_budgets_preserve_a_valid_partial_snapshot(self):
        node = self.root
        for index in range(40):
            child = Element([index+100])
            node.children = [child]
            child.parent = node
            node = child
        value = self.snapshot()
        self.assertTrue(value['truncated'])
        self.assertEqual(max(n['depth'] for n in value['nodes']), 25)
        with patch('canaveral.guest.windows_accessibility.MAX_BYTES', 2200):
            value = self.snapshot()
            self.assertTrue(value['truncated'])
            self.assertLessEqual(len(json.dumps(value).encode()), 2200)

    def test_recycled_runtime_id_with_identical_labels_cannot_replace_retained_handle(self):
        request = self.request()
        replacement = Element(self.button.identity, self.button.CurrentName)
        replacement.parent = self.window
        self.window.children = [replacement]
        self.assertEqual(self.act(request, self.api, clock=lambda: 101), 42)
        self.assertEqual(self.button.invocations, 0)
        self.assertEqual(replacement.invocations, 0)

    def service_request(self, snapshot):
        return {'snapshotId': snapshot['snapshotId'], 'nodeId': snapshot['nodes'][-1]['id'],
                'nativeAction': 'invoke'}

    def test_worker_keeps_private_handles_and_consumes_snapshot_after_invocation(self):
        service = WindowsInspections(self.api, clock=lambda: 100)
        value = service.inspect()
        request = self.service_request(value)
        value['nodes'][-1]['name'] = 'caller changes do not alter saved context'
        self.assertEqual(service.invoke(request), {'status': 'posted'})
        with self.assertRaises(Error) as caught:
            service.invoke(request)
        self.assertEqual(caught.exception.code, 'input_rejected')
        self.assertEqual(self.button.invocations, 1)

    def test_fractional_clock_boundary_keeps_the_action_window_within_fifteen_seconds(self):
        now = [math.nextafter(64.0, 0.0)]
        self.assertGreater((now[0]+15)-now[0], 15)
        service = WindowsInspections(self.api, clock=lambda: now[0])
        request = self.service_request(service.inspect())
        self.assertEqual(service.invoke(request), {'status': 'posted'})
        self.assertEqual(self.button.invocations, 1)
        expired = self.service_request(service.inspect())
        now[0] += 15
        with self.assertRaises(Error):
            service.invoke(expired)
        self.assertEqual(self.button.invocations, 1)

    def test_refresh_and_expiry_invalidate_old_native_targets(self):
        now = [100]
        service = WindowsInspections(self.api, clock=lambda: now[0])
        first = self.service_request(service.inspect())
        service.inspect()
        with self.assertRaises(Error):
            service.invoke(first)
        current = self.service_request(service.inspect())
        now[0] = 116
        with self.assertRaises(Error):
            service.invoke(current)
        self.assertEqual(self.button.invocations, 0)

    def test_worker_uncertainty_is_typed_and_consumed_without_replay(self):
        self.button.invoke_failure = True
        service = WindowsInspections(self.api, clock=lambda: 100)
        request = self.service_request(service.inspect())
        with self.assertRaises(Error) as caught:
            service.invoke(request)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertFalse(caught.exception.retryable)
        with self.assertRaises(Error):
            service.invoke(request)
        self.assertEqual(self.button.invocations, 1)

    def test_invalid_service_requests_and_cross_thread_access_have_no_effect(self):
        service = WindowsInspections(self.api, clock=lambda: 100)
        for bad in (None, {}, {'snapshotId': [], 'nodeId': [], 'nativeAction': 'invoke'}):
            service.inspect()
            with self.assertRaises(Error):
                service.invoke(bad)
        failures = []
        def other_thread():
            try:
                service.inspect()
            except Error as error:
                failures.append(error)
        thread = threading.Thread(target=other_thread)
        thread.start()
        thread.join(2)
        self.assertEqual(len(failures), 1)
        self.assertEqual(self.button.invocations, 0)

    @unittest.skipIf(sys.platform == 'win32', 'No native UI calls in this fixture suite')
    def test_other_platform_never_loads_com_or_uses_a_host_fallback(self):
        with self.assertRaises(Error) as caught:
            with native_api():
                self.fail('Native API must be refused')
        self.assertEqual(caught.exception.code, 'capability_unsupported')
