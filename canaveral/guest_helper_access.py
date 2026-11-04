"""Provider-facing native guest services over an injected assignment binding.

The resolver owns transport authentication, verified destination and boot/lease
identity. No configuration, credentials, image eligibility or enrollment is
created here. Providers may install this object as their access backend only
after supplying that binding; ordinary runners remain gated.
"""
import json
from dataclasses import dataclass

from .guest_chunk_files import GuestChunkFiles
from .guest_chunk_shells import GuestChunkShells
from .guest_stream_display import connect
from .inspection_protocol import MAX_BYTES, validate_snapshot
from .model import Error


@dataclass(frozen=True)
class GuestHelperBinding:
    request: object
    authorized: object
    cleanup_authorized: object = None

    def call(self, path, body, cleanup=False):
        if cleanup and path not in ('/v1/display/release', '/v1/shell/close'):
            raise Error('This guest operation is not owned input or terminal cleanup.', 409)
        allowed = self.cleanup_authorized if cleanup and self.cleanup_authorized is not None else self.authorized
        if not allowed(): raise Error('Guest assignment authorization ended.', 410)
        try:
            result = self.request(path, body)
        except Error as error:
            # Transport errors can contain private endpoints, paths or tokens.
            # Preserve only protocol refusal codes used before native effects.
            code = error.code if error.status == 409 and error.code in (
                'input_busy', 'input_stale', 'input_reset_uncertain', 'capability_unsupported') else None
            raise Error('Native guest request was not confirmed.', error.status, code=code,
                        retryable=False, outcome=error.outcome or
                        ('unknown' if body is not None and code is None else None)) from error
        except Exception as error:
            raise Error('Native guest request was interrupted; inspect before retrying.', 409,
                        retryable=False, outcome='unknown' if body is not None else None) from error
        if not allowed():
            raise Error('Guest assignment authorization ended before acknowledgement.', 410,
                        retryable=False, outcome='unknown' if body is not None else None)
        if not isinstance(result, dict):
            raise Error('Native guest response is malformed.', 409,
                        retryable=False, outcome='unknown' if body is not None else None)
        return result


class GuestHelperAccess:
    # An explicit adapter declaration, not a host/image admission capability.
    inspection_systems = frozenset(('macos',))
    supports_scoped_desktop = True

    def __init__(self, resolve):
        self.resolve = resolve

    def _binding(self, machine, image, folder):
        if image.get('os') != 'macos':
            raise Error('This guest helper adapter supports macOS only.', 409, code='capability_unsupported')
        binding = self.resolve(machine, image, folder)
        if not isinstance(binding, GuestHelperBinding):
            raise Error('Native guest assignment binding is missing.', 409)
        return binding

    @staticmethod
    def _app(app):
        if app is not None:
            raise Error('Native guest files do not use simulator app containers.', 400)

    def control(self, machine, image, folder, request):
        action, arguments = request.get('action'), request.get('arguments')
        if not isinstance(arguments, dict): raise Error('Invalid native guest arguments.', 400)
        if action in ('shell-open', 'shell-read', 'shell-write', 'shell-resize', 'shell-close'):
            binding = self._binding(machine, image, folder)
            call = lambda path, body: binding.call(path, body, cleanup=action == 'shell-close')
            return GuestChunkShells(call).control(action, arguments)
        if action == 'list-files':
            if set(arguments) != {'path'}: raise Error('Invalid native file listing arguments.', 400)
            binding = self._binding(machine, image, folder)
            return GuestChunkFiles(binding.call).list(arguments['path'])
        if action == 'accessibility' and not arguments:
            return self.inspect(machine, image, folder)
        # All pointer/keyboard/semantic effects must carry the owned display
        # connection's stream, frame and ordering context. Never use legacy HTTP
        # input as a fallback when that context is absent.
        from .display_access import InputDenied
        raise InputDenied('This action requires an owned display context or is unsupported.',
                          409, code='capability_unsupported')

    def inspect(self, machine, image, folder, include_frame=False):
        binding = self._binding(machine, image, folder)
        value = binding.call('/v1/accessibility', None)
        try: encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        except (ValueError, TypeError, UnicodeError) as error:
            raise Error('Native accessibility response is malformed.', 409) from error
        if len(encoded) > MAX_BYTES: raise Error('Native accessibility response exceeds its envelope.', 413)
        validate_snapshot(value)
        if value['source'] != 'macos-accessibility' or value['coordinateSpace'] != 'screen-points':
            raise Error('Native accessibility source or coordinates differ.', 409)
        # Native capture/action handles remain inside the helper. Frames travel
        # on the display session; inspection never claims or resets input.
        return value

    def desktop(self, machine, image, folder):
        return self.desktop_session(machine, image, folder, lambda: True)

    def desktop_session(self, machine, image, folder, authorized):
        binding = self._binding(machine, image, folder)
        def request(path, body):
            return binding.call(path, body, cleanup=path == '/v1/display/release')
        return connect(request, lambda: authorized() and binding.authorized(), binding.cleanup_authorized)

    def stream_upload(self, machine, image, folder, path, app, reader, size, authorized):
        self._app(app)
        binding = self._binding(machine, image, folder)
        return GuestChunkFiles(binding.call).upload(path, reader, size,
            lambda: authorized() and binding.authorized())

    def stream_download(self, machine, image, folder, path, app):
        self._app(app)
        binding = self._binding(machine, image, folder)
        return GuestChunkFiles(binding.call).download(path, binding.authorized)
