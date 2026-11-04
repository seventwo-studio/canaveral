"""Inspect a configured Linux deadline artifact without loading executable code."""
import hashlib
import os
import struct
from pathlib import Path

from .libvirt_execution import library_digest
from .model import Error


EXPORTS = {'canaveral_lease_deadline_install', 'canaveral_lease_deadline_arm'}


def deadline_artifact(path, arch):
    """Validate an ELF snapshot, not runtime ABI behavior or lease acceptance."""
    try:
        path = Path(path)
        if not path.is_absolute() or arch not in ('amd64', 'arm64'): raise ValueError()
        fd = os.open(path, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            checksum = library_digest(fd)
            os.lseek(fd, 0, os.SEEK_SET)
            with os.fdopen(fd, 'rb', closefd=False) as source: data = source.read(8*1048576+1)
            os.lseek(fd, 0, os.SEEK_SET)
            if hashlib.sha256(data).hexdigest() != checksum or library_digest(fd) != checksum: raise ValueError()
        finally: os.close(fd)
        if (len(data) < 64 or data[:7] != b'\x7fELF\x02\x01\x01' or data[7] not in (0, 3)):
            raise ValueError()
        header = struct.unpack_from('<HHIQQQIHHHHHH', data, 16)
        kind, machine, version, _, phoff, shoff, _, ehsize, phsize, phcount, shsize, shcount, _ = header
        if (kind != 3 or machine != {'amd64':62, 'arm64':183}[arch] or version != 1 or ehsize != 64
                or phsize != 56 or phcount == 0 or shsize != 64 or shcount == 0): raise ValueError()

        def region(offset, size):
            if offset < 0 or size < 0 or offset+size > len(data): raise ValueError()
            return data[offset:offset+size]

        region(phoff, phsize*phcount); region(shoff, shsize*shcount)
        segments = set()
        for index in range(phcount):
            segment, _, offset, _, _, size, memory, _ = struct.unpack_from('<IIQQQQQQ', data, phoff+index*phsize)
            region(offset, size)
            if memory < size: raise ValueError()
            segments.add(segment)
        if not {1, 2}.issubset(segments): raise ValueError() # PT_LOAD and PT_DYNAMIC.
        sections = [struct.unpack_from('<IIQQQQIIQQ', data, shoff+index*shsize) for index in range(shcount)]
        exports = set()
        for section in sections:
            if section[1] != 11: continue # SHT_DYNSYM.
            if section[9] != 24 or section[5] % 24 or not 0 <= section[6] < len(sections): raise ValueError()
            strings = sections[section[6]]
            if strings[1] != 3: raise ValueError() # SHT_STRTAB.
            names = region(strings[4], strings[5]); symbols = region(section[4], section[5])
            for offset in range(0, len(symbols), 24):
                name, info, visibility, defined, address, size = struct.unpack_from('<IBBHQQ', symbols, offset)
                if name >= len(names): raise ValueError()
                if info >> 4 == 1 and info & 15 == 2 and visibility & 3 in (0, 3) and defined != 0:
                    for exported in EXPORTS:
                        expected = exported.encode('ascii')+b'\0'
                        if names[name:name+len(expected)] != expected: continue
                        if defined >= len(sections): raise ValueError()
                        code = sections[defined]
                        if (code[1] != 1 or not code[2] & 4 or size <= 0 or
                                address < code[3] or address+size > code[3]+code[5]): raise ValueError()
                        region(code[4], code[5]); exports.add(exported)
        if not EXPORTS.issubset(exports): raise ValueError()
        return {'path': str(path), 'sha256': checksum, 'arch': arch, 'format': 'elf64', 'exports': sorted(EXPORTS)}
    except (OSError, ValueError, TypeError, struct.error, UnicodeError, Error):
        raise Error('Configured Linux deadline artifact is invalid or unsupported.', 409,
                    code='lease_deadline_artifact_invalid') from None
