"""Publish a verified SDK download without exposing partial destination bytes."""
import os
import secrets
from pathlib import Path

from .model import Error


def receive_file(destination,transfer,replace=False,request_id=None):
    if type(replace) is not bool:raise Error('Download replacement must be explicit.',400)
    destination=Path(destination)
    if not destination.name:raise Error('Choose a destination filename.',400)
    directory=None;temporary=None;stage='prepare'
    try:
        # POSIX operations stay bound to this directory even if its path moves.
        if os.name!='nt':directory=os.open(destination.parent,os.O_RDONLY|getattr(os,'O_DIRECTORY',0))
        options={'dir_fd':directory} if directory is not None else {}
        target=destination.name if directory is not None else str(destination)
        if not replace:
            try:os.stat(target,follow_symlinks=False,**options)
            except FileNotFoundError:pass
            else:raise Error('Download destination already exists.',409,code='download_destination_exists',request_id=request_id)
        name='.canaveral-download-'+secrets.token_hex(16)
        candidate=name if directory is not None else str(destination.parent/name)
        fd=os.open(candidate,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,**options)
        temporary=candidate
        stage='receive'
        with os.fdopen(fd,'wb') as output:
            result=transfer(output)
            output.flush();os.fsync(output.fileno())
        stage='publish'
        bindings={'src_dir_fd':directory,'dst_dir_fd':directory} if directory is not None else {}
        if replace:os.replace(temporary,target,**bindings)
        else:os.link(temporary,target,**bindings)
        stage='directory-sync'
        if not replace:os.unlink(temporary,**options)
        temporary=None
        if directory is not None:os.fsync(directory)
        return result
    except Error as error:
        if stage=='receive':
            raise Error('Download did not complete verified local publication; the destination was not replaced.',error.status,
                code=error.code,request_id=error.request_id or request_id,retryable=error.retryable,outcome=error.outcome) from error
        raise
    except OSError as error:
        if stage=='publish' and isinstance(error,FileExistsError):
            raise Error('Download destination appeared before publication; it was not replaced.',409,
                code='download_destination_exists',request_id=request_id) from error
        uncertain=stage in ('publish','directory-sync')
        raise Error('Local download publication is uncertain; inspect the destination before retrying.' if uncertain else
                    'Download failed before local publication; the destination was not replaced.',409,
                    code='download_publication_uncertain' if uncertain else 'download_destination_failed',request_id=request_id,
                    outcome='unknown' if uncertain else None) from error
    finally:
        try:
            if temporary is not None:
                try:os.unlink(temporary,**({'dir_fd':directory} if directory is not None else {}))
                except FileNotFoundError:pass
                except OSError as error:
                    raise Error('Local download publication or temporary cleanup needs inspection before retrying.',409,
                        code='download_publication_uncertain' if stage in ('publish','directory-sync') else 'download_temporary_cleanup_failed',
                        request_id=request_id,outcome='unknown' if stage in ('publish','directory-sync') else None) from error
        finally:
            if directory is not None:os.close(directory)
