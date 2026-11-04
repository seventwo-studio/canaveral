"""Bounded-memory guest transfers without a per-file size cap."""
import os
import hashlib
import stat
import secrets
from pathlib import PurePosixPath

from .model import Error

CHUNK=1048576


def copy_upload(reader, writer, size, authorized=lambda: True):
    remaining=size
    while remaining:
        if not authorized():raise Error('Upload authorization ended.',401)
        data=reader.read(min(CHUNK,remaining))
        if not data:raise Error('Upload interrupted before all bytes arrived.',400)
        if len(data)>min(CHUNK,remaining):raise Error('Upload source exceeded its declared length.',400)
        if not authorized():raise Error('Upload authorization ended during read.',401)
        writer.write(data)
        remaining-=len(data)


def confined_file(root, relative):
    path=PurePosixPath(relative)
    if path.is_absolute() or '..' in path.parts or not path.name or path.name=='.':raise Error('Use a file path inside the app container.',400)
    fd=os.open(str(root),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in path.parts[:-1]:
            following=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=following
        return fd,path.name
    except Exception:
        os.close(fd);raise


def atomic_upload(parent, name, reader, size, authorized=lambda: True):
    temporary='.canaveral-upload-'+secrets.token_hex(16)
    try:
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
        with os.fdopen(fd,'wb') as output:
            copy_upload(reader,output,size,authorized)
            output.flush();os.fsync(output.fileno())
        if not authorized():raise Error('Upload authorization ended before completion.',401)
        os.replace(temporary,name,src_dir_fd=parent,dst_dir_fd=parent)
        # The acknowledgement covers both file data and the directory rename.
        os.fsync(parent)
        return {'uploaded':size,'durable':True}
    finally:
        try:os.unlink(temporary,dir_fd=parent)
        except FileNotFoundError:pass


class Download:
    def __init__(self,reader,size,close=None,verify=None):
        self.reader,self.size,self._close=reader,size,close
        self._verify=verify;self.identity=None
        try:
            metadata=os.fstat(reader.fileno())
            if stat.S_ISREG(metadata.st_mode):self.identity=file_identity(metadata)
        except (OSError,AttributeError):pass
    def read(self,size):return self.reader.read(size)
    def verify(self):
        if self._verify:
            if self._verify() is not True:raise Error('Download source identity changed.',409)
        elif not self.identity or file_identity(os.fstat(self.reader.fileno()))!=self.identity:
            raise Error('Download source identity changed or could not be verified.',409)
    def close(self):
        self.reader.close()
        if self._close:self._close()


def file_identity(metadata):
    values=(metadata.st_dev,metadata.st_ino,metadata.st_size,metadata.st_mtime_ns,metadata.st_ctime_ns)
    return hashlib.sha256(':'.join(map(str,values)).encode()).hexdigest()
