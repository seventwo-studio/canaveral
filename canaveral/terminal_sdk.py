"""One scoped PTY attachment; bounded controls, concurrent read/write, no replay."""
import json
import math
import threading

from .model import Error,identifier
from .session_errors import checked


class TerminalClient:
    @staticmethod
    def validate_timeout(timeout,allow_zero=True):
        try:valid=type(timeout) in (int,float) and math.isfinite(timeout)
        except OverflowError:valid=False
        if not valid or (timeout<0 if allow_zero else timeout<=0):
            raise Error('Choose a finite terminal timeout.',400)

    def __init__(self,connection,session_id):
        self.session_id=identifier(session_id);self.connection=connection
        self._closed=threading.Event();self.close_lock=threading.Lock()
        self.read_lock=threading.Lock();self.write_lock=threading.Lock()
        self.exited=False;self.exit_code=None;self.truncated=False

    def __enter__(self):return self
    def __exit__(self,*args):self.close()

    @property
    def closed(self):return self._closed.is_set()

    def close(self):
        with self.close_lock:
            if not self.closed:
                self._closed.set();self.connection.close()

    def _check(self):
        if self.closed:
            raise Error('Terminal connection ended; input is not replayed.',410,code='session_disconnected',
                        request_id=self.session_id,retryable=False)

    def _failure(self,error):
        if isinstance(error,Error):
            if not error.request_id:error.request_id=self.session_id
            error.outcome='unknown';error.retryable=False
        else:
            error=Error('Terminal completion was not confirmed. Inspect the session before sending more input.',
                        409,code='session_incomplete',request_id=self.session_id,retryable=False,outcome='unknown')
        try:self.close()
        except OSError:pass
        return error

    def _control(self,value):
        # Match the transport's JSON encoding before dispatch. Never split input
        # silently: a partial write is not a command acknowledgement.
        if len(json.dumps(value,allow_nan=False).encode('utf-8'))>16384:
            raise Error('Terminal input exceeds the 16 KiB control envelope; send smaller explicit writes.',400)
        with self.write_lock:
            self._check()
            try:self.connection.send_control(value)
            except (Error,OSError,EOFError) as error:raise self._failure(error)
            except BaseException:
                try:self.close()
                except OSError:pass
                raise

    def write(self,text):
        if not isinstance(text,str) or len(text)>16000 or '\x00' in text:
            raise Error('Terminal input must be text without NUL, within 16000 characters.',400)
        try:text.encode('utf-8')
        except UnicodeError as error:raise Error('Terminal input must be valid UTF-8 text.',400) from error
        self._control({'action':'shell-write','arguments':{'text':text}})

    def resize(self,cols,rows):
        if any(type(n) is not int or not 1<=n<=500 for n in (cols,rows)):
            raise Error('Terminal columns and rows must be integers between 1 and 500.',400)
        self._control({'action':'shell-resize','arguments':{'cols':cols,'rows':rows}})

    def receive(self,timeout=30):
        """Return raw bytes, an exit/truncation event, or None on timeout."""
        self.validate_timeout(timeout)
        with self.read_lock:
            self._check()
            try:
                value=checked(self.connection.receive(timeout),self.session_id)
                self._check()
                if value is None:return None
                if isinstance(value,bytes) and len(value)<=65536:return value
                if isinstance(value,dict):
                    if value=={'type':'truncated'}:
                        self.truncated=True;return value
                    if (set(value)=={'type','exitCode'} and value['type']=='exited' and
                        (value['exitCode'] is None or type(value['exitCode']) is int)):
                        self.exited=True;self.exit_code=value['exitCode'];self.close();return value
                raise Error('Invalid terminal output control.',409,code='session_protocol_error')
            except (Error,OSError,EOFError) as error:raise self._failure(error)
            except BaseException:
                try:self.close()
                except OSError:pass
                raise
