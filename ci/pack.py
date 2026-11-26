"""Inspect a provider archive without extracting its files. Output contains counts and hashes."""
import binascii
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import sys
from zipfile import ZipFile
import zlib


def require(condition):
    if not condition:
        raise ValueError("Invalid evidence archive")


def screenshot(data):
    require(data.startswith(b"\x89PNG\r\n\x1a\n"))
    offset = 8
    compressed = bytearray()
    has_palette = False
    while offset + 12 <= len(data):
        length, kind = struct.unpack_from(">I4s", data, offset)
        body = data[offset + 8:offset + 8 + length]
        end = offset + length + 12
        require(end <= len(data))
        require(binascii.crc32(kind + body) == int.from_bytes(data[end - 4:end], "big"))
        if offset == 8:
            require(kind == b"IHDR" and length == 13)
            width, height, depth, color, compression, filters, interlace = struct.unpack(">II5B", body)
            require(0 < width <= 8192 and 0 < height <= 8192)
            depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            require(depth in depths.get(color, ()) and compression == filters == 0 and interlace in (0, 1))
        elif kind == b"IHDR":
            raise ValueError("Duplicate PNG header")
        if kind == b"PLTE":
            require(not compressed and 0 < length <= 768 and length % 3 == 0)
            has_palette = True
        if kind == b"IDAT":
            compressed.extend(body)
        if kind == b"IEND":
            decoder = zlib.decompressobj()
            require(length == 0 and end == len(data) and compressed)
            pixels = decoder.decompress(compressed, 32 << 20)
            require(decoder.eof and not decoder.unused_data and (color != 3 or has_palette))
            bits = depth * {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
            passes = [(0, 0, 1, 1)] if not interlace else [
                (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
                (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
            cursor = 0
            for x, y, dx, dy in passes:
                columns = len(range(x, width, dx))
                if columns:
                    row_bytes = 1 + (bits * columns + 7) // 8
                    for _ in range(y, height, dy):
                        require(cursor + row_bytes <= len(pixels) and pixels[cursor] <= 4)
                        cursor += row_bytes
            require(cursor == len(pixels))
            return
        offset = end
    raise ValueError("Incomplete PNG")


def inspect(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 16 << 20)
    images, failures, names = {}, set(), set()
    with ZipFile(path) as archive:
        entries = archive.infolist()
        require(len(entries) <= 500 and sum(i.file_size for i in entries) <= 32 << 20)
        for entry in entries:
            name = entry.filename
            require(name not in names and not PurePosixPath(name).is_absolute())
            require(not any(c in name for c in ("\\", ":", "\x00")) and ".." not in name.split("/"))
            require(not entry.flag_bits & 1 and entry.file_size <= 8 << 20)
            require(stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG, stat.S_IFDIR))
            names.add(name)
            data = archive.read(entry)
            match = re.fullmatch(r"(tests/[^/]+/steps/[^/]+)/(screenshot\.png|failure\.yaml)", name)
            if match and match[2] == "screenshot.png":
                screenshot(data)
                images[match[1]] = hashlib.sha256(data).hexdigest()
            elif match and data:
                failures.add(match[1])
        require("run.yaml" in names and archive.read("run.yaml"))
        run_id = re.search(rb"""(?m)^run_id:[ \t]*["']?([A-Za-z0-9_-]{1,128})["']?[ \t]*\r?$""", archive.read("run.yaml"))
        require(any(re.fullmatch(r"tests/[^/]+/result\.yaml", n) and archive.read(n) for n in names))
    require(images)
    result = {"screenshots": sorted(images.values()), "failedStep": bool(failures.intersection(images))}
    if run_id:
        result["runId"] = run_id[1].decode("ascii")
    return result


if __name__ == "__main__":
    print(json.dumps(inspect(Path(sys.argv[1]))))
