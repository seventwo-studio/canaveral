"""Native guest HTTP frames/held input adapted to the common private RFB socket.

The provider must inject an authenticated, assignment-bound request callable:
request(path, None) reads; request(path, object) posts. It owns TLS/destination,
credential and authorization decisions. This adapter enables no image or lease.
"""
import base64
import json
import math
import socket
import threading
import time
import uuid

from .model import Error
from .simulator_screen import SimulatorScreen, ScreenConnection, dimensions, compact_length


def _uuid(value):
    try:return str(uuid.UUID(value))
    except (ValueError,TypeError,AttributeError):raise Error('Native display identity is invalid.',409)


class GuestStreamScreen(SimulatorScreen):
    def __init__(self,request,authorized,cleanup_authorized=None,capture_retry_timeout=5):
        super().__init__(None,None,None,None,authorized)
        if type(capture_retry_timeout) not in (int,float) or not math.isfinite(capture_retry_timeout) or capture_retry_timeout<0:
            raise Error('Native capture retry timeout must be finite and nonnegative.',400)
        self.capture_retry_timeout=capture_retry_timeout
        self.request=request
        self.cleanup_authorized=authorized if cleanup_authorized is None else cleanup_authorized
        self.native_lock=threading.RLock()
        self.closed=threading.Event()
        self.stream=None;self.sequence=0;self.owned=False;self.uncertain=False
        self.frame=None;self.frame_size=None

    def _call(self,path,body,cleanup=False):
        allowed=self.cleanup_authorized if cleanup else self.authorized
        if not allowed() or (self.closed.is_set() and not cleanup):
            raise Error('Native display authorization ended.',410)
        result=self.request(path,body)
        if not isinstance(result,dict):raise Error('Native display response is malformed.',409)
        if not allowed() or (self.closed.is_set() and not cleanup):
            raise Error('Native display authorization ended before acknowledgement.',410)
        return result

    def capture(self):
        with self.native_lock:
            deadline=time.monotonic()+self.capture_retry_timeout
            while True:
                try:
                    value=self._call('/v1/display/frame',None);break
                except Error as error:
                    if error.status!=409 or error.code not in ('input_busy','input_stale') or time.monotonic()>=deadline:raise
                    # Only an explicitly requested read is retried. Input never
                    # refreshes to unseen pixels or retries a mutation.
                    time.sleep(.025)
            frame=value.get('frame');bounds=value.get('bounds');display=value.get('displayID')
            if (not isinstance(frame,dict) or not isinstance(bounds,dict) or type(display) is not int or not 0<display<=2**32-1
                    or set(bounds)!={'x','y','width','height'}):raise Error('Native display metadata is malformed.',409)
            for coordinate in bounds.values():
                if type(coordinate) not in (int,float):raise Error('Native display bounds are invalid.',409)
                try:valid=math.isfinite(coordinate)
                except OverflowError:valid=False
                if not valid:raise Error('Native display bounds are invalid.',409)
            if bounds['width']<=0 or bounds['height']<=0:raise Error('Native display bounds are empty.',409)
            encoded=frame.get('pngBase64')
            try:
                if not isinstance(encoded,str) or len(encoded)>8_000_000:raise ValueError()
                png=base64.b64decode(encoded,validate=True)
            except (ValueError,TypeError):raise Error('Native display image is malformed.',409)
            size=dimensions(png)
            if (type(frame.get('width')) is not int or type(frame.get('height')) is not int
                    or size!=(frame['width'],frame['height']) or max(size)>4096):
                raise Error('Native display pixels differ from their metadata.',409)
            compact_length(len(png)) # Reject an unsendable frame before adopting its input binding.
            self.frame=_uuid(frame.get('id'));self.frame_size=size
            return png

    def take_input(self):
        with self.native_lock:
            if self.closed.is_set() or not self.authorized():raise Error('Native input authorization ended.',410)
            if self.uncertain or (self.stream is not None and not self.owned):return 'reset-uncertain'
            if self.stream is None:self.stream=str(uuid.uuid4());self.sequence=0
            try:
                result=self._call('/v1/display/take',{'streamId':self.stream})
                if (_uuid(result.get('streamId'))!=self.stream or result.get('state')!='owned'
                        or type(result.get('sequence')) is not int or result['sequence']!=self.sequence):
                    raise Error('Native input claim was not confirmed.',409)
            except Error as error:
                if error.status==409 and error.code=='input_busy':
                    self.stream=None;self.owned=False
                    return 'busy' # The helper explicitly refused this claim before effects.
                if error.status==409 and error.code=='input_reset_uncertain':self.stream=None;self.owned=False
                self.uncertain=True
                return 'reset-uncertain'
            except BaseException:
                self.uncertain=True
                raise
            self.owned=True
            return 'owned'

    def _send(self,event):
        with self.native_lock:
            if not self.owned or self.uncertain or self.frame is None:
                raise Error('Native stream does not own fresh input.',409)
            value={'streamId':self.stream,'sequence':self.sequence+1,'frameId':self.frame,'event':event}
            if len(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode('utf-8'))>16384:
                raise Error('Native display input exceeds its control envelope.',400)
            if self.sequence>=2**53-1:raise Error('Native input sequence is exhausted.',409)
            try:
                result=self._call('/v1/display/input',value)
                if (_uuid(result.get('streamId'))!=self.stream or type(result.get('sequence')) is not int
                        or result['sequence']!=self.sequence+1 or result.get('posted') is not True):
                    raise Error('Native input acknowledgement differs; input will not be replayed.',409)
            except BaseException:
                self.uncertain=True
                raise
            self.sequence+=1

    def pointer(self,mask,x,y):
        with self.native_lock:
            if (type(mask) is not int or not 0<=mask<=255 or self.frame_size is None
                    or type(x) is not int or type(y) is not int
                    or not 0<=x<self.frame_size[0] or not 0<=y<self.frame_size[1]):
                raise Error('Pointer is outside the issued native frame.',400)
            self._send({'type':'pointer','x':x,'y':y,'buttons':mask})

    def key(self,down,keysym):
        if type(down) is not int or down not in (0,1) or type(keysym) is not int or not 0<=keysym<=2**32-1:
            raise Error('Invalid native RFB key event.',400)
        self._send({'type':'key','keysym':keysym,'down':bool(down)})

    def action(self,action,arguments):
        if action!='text' or set(arguments)!={'text'}:raise Error('Unsupported native clipboard operation.',400)
        text=arguments['text']
        if not isinstance(text,str) or '\0' in text:raise Error('Invalid native clipboard text.',400)
        try:size=len(text.encode('utf-8'))
        except UnicodeEncodeError:raise Error('Invalid native clipboard Unicode.',400)
        if size>16000:raise Error('Native clipboard text exceeds its envelope.',400)
        self._send({'type':'text','text':text})

    def control_action(self,request):
        from .devices import operation_request
        from .display_access import InputDenied
        request=operation_request(request)
        with self.native_lock:
            if not self.owned or self.uncertain or self.closed.is_set() or not self.authorized():
                raise InputDenied('Native display does not own this input context.',409,code='input_not_owned')
            if request['action'] not in ('tap','text','key','accessibility-action'):
                raise InputDenied('This native semantic action is unsupported.',409,code='capability_unsupported')
            value={'streamId':self.stream,**request}
            if request['action']!='accessibility-action':
                if self.frame is None:raise InputDenied('Capture a native frame before acting.',409,code='input_stale')
                value['frameId']=self.frame
            if len(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode('utf-8'))>16384:
                raise InputDenied('Native semantic action exceeds its envelope.',400,code='invalid_request')
            try:
                result=self._call('/v1/display/action',value)
                if _uuid(result.get('id'))!=request['id'] or result.get('status')!='posted':
                    raise Error('Native semantic input outcome is unconfirmed.',409)
            except Error as error:
                if error.status==409 and error.code in ('input_busy','input_stale','capability_unsupported'):
                    raise InputDenied('Native semantic input was refused before dispatch.',409,code=error.code) from error
                self.uncertain=True
                raise Error('Native semantic input outcome is unknown; inspect before retrying.',409) from error
            except BaseException:
                self.uncertain=True;raise
            return {'posted':True}

    def _release(self):
        if self.stream is None:return not self.uncertain
        result=self._call('/v1/display/release',{'streamId':self.stream},cleanup=True)
        if result.get('released') is not True:raise Error('Native held-input reset was not confirmed.',409)
        self.stream=None;self.sequence=0;self.owned=False;self.uncertain=False
        return True

    def reset_input(self):
        with self.native_lock:return self._release()

    def close_input(self):
        self.closed.set()
        with self.native_lock:
            try:self._release()
            except Exception:pass # Unknown cleanup never becomes a positive ordered barrier.


class GuestStreamConnection(ScreenConnection):
    supports_input_claim=True
    supports_semantic_context=True
    def take_input(self):return self.screen.take_input()
    def control_action(self,request):
        # This executes inside the provider's durable operation receipt, after
        # all preceding raw RFB messages, rather than overtaking queued keys.
        if self.barrier(reset=False) is not True:raise Error('Native input ordering barrier was not confirmed.',409)
        return self.screen.control_action(request)


def connect(request,authorized,cleanup_authorized=None,capture_retry_timeout=5):
    client,worker=socket.socketpair()
    screen=GuestStreamScreen(request,authorized,cleanup_authorized,capture_retry_timeout)
    threading.Thread(target=screen.serve,args=(worker,),daemon=True).start()
    return GuestStreamConnection(client,screen)
