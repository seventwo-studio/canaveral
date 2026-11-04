"""Scoped RFB 3.8 viewer and input client; no connection or input replay.

Raw, TightPNG/JPEG/fill and DesktopSize rectangles share one framebuffer. Image
decoding is optional: install canaveral-machines[visual] on the consuming client.
"""
import contextlib
import io
import math
import struct
import threading
import time

from .devices import operation_request
from .display_access import INPUT_ACTIONS
from .model import Error,identifier
from .session_errors import checked


class DisplayClient:
    @staticmethod
    def require_images():
        try:
            from PIL import Image
        except ImportError as error:
            raise Error('Install canaveral-machines[visual] to use the display SDK.',409,code='capability_unsupported') from error
        return Image

    @classmethod
    def validate_options(cls,timeout,max_frame_bytes):
        cls.deadline(timeout)
        if type(max_frame_bytes) is not int or max_frame_bytes<4:raise Error('Choose a positive decoded framebuffer budget.',400)

    def __init__(self,connection,timeout=30,max_frame_bytes=64*1024*1024):
        self.connection=connection;self.closed=False;self.lock=threading.RLock()
        self.buffer=bytearray();self.initialized=False;self.state=None
        self.waiting=None;self.result=None;self.rectangles=None;self.updates=0
        try:
            self.Image=self.require_images()
            self.validate_options(timeout,max_frame_bytes)
            self.max_frame_bytes=max_frame_bytes
            deadline=self.deadline(timeout)
            if self.read(12,deadline)!=b'RFB 003.008\n':raise Error('Display requires RFB 3.8.',409,code='capability_unsupported')
            self.connection.send_bytes(b'RFB 003.008\n')
            count=self.read(1,deadline)[0]
            if not count or 1 not in self.read(count,deadline):raise Error('Display transport did not offer protected initialization.',409)
            self.connection.send_bytes(b'\x01')
            if self.read(4,deadline)!=bytes(4):raise Error('Display initialization was refused.',409)
            self.connection.send_bytes(b'\x01') # Shared viewer; never evict another peer.
            header=self.read(24,deadline)
            width,height=struct.unpack('!HH',header[:4]);name_size=struct.unpack('!I',header[20:])[0]
            if name_size>4096:raise Error('Display name exceeds its protocol envelope.',409)
            self.read(name_size,deadline);self.resize(width,height)
            # RGBX bytes, independent of the backend's native pixel layout.
            pixels=struct.pack('!BBBBHHHBBB3x',32,24,0,1,255,255,255,0,8,16)
            self.connection.send_bytes(bytes(4)+pixels+struct.pack('!BBHiii',2,0,3,-260,0,-223))
            self.initialized=True;self.parse()
            self.wait(lambda:self.state is not None,deadline)
        except BaseException:
            self.close();raise

    @staticmethod
    def deadline(timeout):
        if type(timeout) not in (int,float) or not math.isfinite(timeout) or timeout<=0:raise Error('Choose a positive display timeout.',400)
        return time.monotonic()+timeout

    @contextlib.contextmanager
    def operation(self,request_id=None,owned=False):
        with self.lock:
            if self.closed:raise Error('Display connection ended; input is not replayed.',410,request_id=request_id)
            if owned:self.require_owner()
            try:yield
            except BaseException as error:
                if isinstance(error,Error) and request_id:
                    if not error.request_id or error.request_id==getattr(self.connection,'session_id',None):error.request_id=request_id
                self.close();raise

    def close(self):
        if not self.closed:
            self.closed=True;self.state='closed';self.connection.close()

    def __enter__(self):return self
    def __exit__(self,*args):self.close()

    def resize(self,width,height):
        if not width or not height or width*height*4>self.max_frame_bytes:raise Error('Display exceeds the configured decoded framebuffer budget.',413)
        self.width,self.height=width,height
        self.image=self.Image.new('RGB',(width,height))
        self.missing=self.Image.new('1',(width,height),1)

    def receive(self,deadline):
        remaining=deadline-time.monotonic()
        if remaining<=0:raise Error('Display response timed out; input may have been delivered. Inspect its receipt before retrying.',408,request_id=self.waiting)
        value=self.connection.receive(remaining)
        if value is None:raise Error('Display response timed out; input is not replayed.',408,request_id=self.waiting)
        if isinstance(value,bytes):
            if len(self.buffer)+len(value)>self.max_frame_bytes+65536:raise Error('Display data exceeds the configured decode budget.',413)
            self.buffer.extend(value)
            if self.initialized:self.parse()
        elif isinstance(value,dict):
            if value.get('type')=='control':
                if value.get('state') not in ('owned','busy','view-only','reset-uncertain','stale','not-ready'):raise Error('Invalid display ownership response.',409)
                self.state=value['state']
            elif value.get('type')=='action-result' and value.get('id')==self.waiting:
                if value.get('state') not in ('succeeded','failed','unknown') or not isinstance(value.get('result'),dict):raise Error('Invalid action receipt.',409)
                self.result=value
            elif value.get('type')=='error':checked(value,self.waiting or getattr(self.connection,'session_id',None))
        else:raise Error('Invalid display message.',409)

    def read(self,size,deadline):
        while len(self.buffer)<size:self.receive(deadline)
        value=bytes(self.buffer[:size]);del self.buffer[:size]
        return value

    def wait(self,predicate,deadline):
        while not predicate():self.receive(deadline)

    def parse(self):
        while self.buffer:
            if self.rectangles is None:
                kind=self.buffer[0]
                if kind==2:del self.buffer[:1];continue # Bell has no payload.
                if kind==3:
                    if len(self.buffer)<8:return
                    size=struct.unpack('!I',self.buffer[4:8])[0]
                    if size>16384:raise Error('Display clipboard output exceeds its envelope.',409)
                    if len(self.buffer)<8+size:return
                    del self.buffer[:8+size];continue
                if kind!=0:raise Error('Unsupported display server message.',409,code='capability_unsupported')
                if len(self.buffer)<4:return
                self.rectangles=struct.unpack('!H',self.buffer[2:4])[0];del self.buffer[:4]
                if not self.rectangles:self.rectangles=None;self.updates+=1;continue
            if len(self.buffer)<12:return
            x,y,width,height,encoding=struct.unpack('!HHHHi',self.buffer[:12])
            if encoding==-223:
                self.resize(width,height);used=12
            else:
                if not width or not height or x+width>self.width or y+height>self.height:raise Error('Display rectangle is outside the current framebuffer.',409)
                result=self.rectangle(width,height,encoding)
                if result is None:return
                image,used=result
                self.image.paste(image,(x,y));self.missing.paste(0,(x,y,x+width,y+height))
            del self.buffer[:used];self.rectangles-=1
            if not self.rectangles:self.rectangles=None;self.updates+=1

    def rectangle(self,width,height,encoding):
        if encoding==0:
            size=width*height*4
            if len(self.buffer)<12+size:return None
            image=self.Image.frombytes('RGB',(width,height),bytes(self.buffer[12:12+size]),'raw','RGBX')
            return image,12+size
        if encoding!=-260:raise Error('Display used an encoding the SDK did not negotiate.',409,code='capability_unsupported')
        if len(self.buffer)<13:return None
        kind=self.buffer[12]>>4
        if kind==8:
            if len(self.buffer)<16:return None
            return self.Image.new('RGB',(width,height),tuple(self.buffer[13:16])),16
        if kind not in (9,10):raise Error('Unsupported TightPNG rectangle.',409,code='capability_unsupported')
        size=0;offset=13
        for index in range(3):
            if len(self.buffer)<=offset:return None
            part=self.buffer[offset];offset+=1
            size|=(part if index==2 else part&127)<<(index*7)
            if index==2 or not part&128:break
        if size>self.max_frame_bytes:raise Error('Compressed display image exceeds its envelope.',413)
        if len(self.buffer)<offset+size:return None
        try:
            with self.Image.open(io.BytesIO(bytes(self.buffer[offset:offset+size])),formats=['PNG' if kind==10 else 'JPEG']) as image:
                if image.size!=(width,height):raise Error('Compressed display dimensions differ from the rectangle.',409)
                decoded=image.convert('RGB')
        except Error:raise
        except Exception as error:raise Error('Display image could not be decoded.',409) from error
        return decoded,offset+size

    def screenshot(self,timeout=30):
        """Return a complete PNG; never substitute a partial/blank framebuffer."""
        deadline=self.deadline(timeout)
        with self.operation():
            self.missing=self.Image.new('1',(self.width,self.height),1)
            while True:
                update=self.updates
                self.connection.send_bytes(struct.pack('!BBHHHH',3,0,0,0,self.width,self.height))
                self.wait(lambda:self.updates>update,deadline)
                if self.missing.getbbox() is None:
                    output=io.BytesIO();self.image.save(output,format='PNG');return output.getvalue()

    def input_control(self,action,timeout):
        deadline=self.deadline(timeout)
        if action not in ('take','release'):raise Error('Choose take or release input control.',400)
        with self.operation():
            self.state=None
            self.connection.send_control({'type':'input-control','action':action})
            self.wait(lambda:self.state is not None,deadline)
            return self.state

    def take_control(self,timeout=30):return self.input_control('take',timeout)
    def release_control(self,timeout=30):return self.input_control('release',timeout)

    def require_owner(self):
        if self.closed or self.state!='owned':raise Error('Take display input ownership before sending input.',409,code='input_busy')

    def key(self,keysym,down=True):
        if type(keysym) is not int or not 0<=keysym<=0xffffffff or type(down) is not bool:raise Error('Use a 32-bit RFB keysym and a boolean down state.',400)
        with self.operation(owned=True):
            self.connection.send_bytes(struct.pack('!BB2xI',4,int(down),keysym))

    def press_key(self,keysym):
        if type(keysym) is not int or not 0<=keysym<=0xffffffff:raise Error('Use a 32-bit RFB keysym.',400)
        with self.operation(owned=True):
            self.connection.send_bytes(struct.pack('!BB2xI',4,1,keysym)+struct.pack('!BB2xI',4,0,keysym))

    def validate_pointer(self,x,y,buttons):
        if type(x) is not int or type(y) is not int or not 0<=x<self.width or not 0<=y<self.height or type(buttons) is not int or not 0<=buttons<=255:raise Error('Pointer coordinates or button mask are outside the display.',400)

    def pointer(self,x,y,buttons=0):
        self.validate_pointer(x,y,buttons)
        with self.operation(owned=True):
            self.connection.send_bytes(struct.pack('!BBHH',5,buttons,x,y))

    def click(self,x,y,button=1):
        self.validate_pointer(x,y,button)
        if not button or button&(button-1):raise Error('Choose one pointer button bit.',400)
        with self.operation(owned=True):
            self.connection.send_bytes(struct.pack('!BBHH',5,button,x,y)+struct.pack('!BBHH',5,0,x,y))

    def action(self,request_id,action,arguments,timeout=30):
        request=operation_request({'id':identifier(request_id),'action':action,'arguments':arguments})
        if action not in INPUT_ACTIONS:raise Error('Use a provider-supported input action.',400)
        return self.receipt_request({'type':'action',**request},timeout,owned=True)

    def receipt(self,request_id,timeout=30):
        return self.receipt_request({'type':'action-receipt','id':identifier(request_id)},timeout)

    def receipt_request(self,value,timeout,owned=False):
        deadline=self.deadline(timeout)
        with self.operation(value['id'],owned):
            self.waiting=value['id'];self.result=None
            try:
                self.connection.send_control(value)
                self.wait(lambda:self.result is not None,deadline)
            except Error as error:
                # Dispatch can fail after forwarding bytes; absence of a receipt
                # does not establish that the action had no guest effects.
                error.outcome='unknown';error.retryable=False
                raise
            except (OSError,EOFError) as error:
                raise Error('Display completion was not confirmed. Inspect the original action receipt before retrying.',
                            409,code='session_incomplete',request_id=value['id'],retryable=False,outcome='unknown') from error
            result=self.result;self.waiting=None;self.result=None
            if value['type']=='action' and result['state']=='unknown':self.state='reset-uncertain'
            return result
