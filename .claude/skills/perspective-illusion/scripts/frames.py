"""Shared helpers: read video frames through ffmpeg, write PNGs without PIL."""
from __future__ import annotations

import re
import struct
import subprocess
import zlib
from typing import Iterator, Tuple

import numpy as np


def video_size(ffmpeg: str, path: str) -> Tuple[int, int]:
    """Width and height of the first video stream (parsed from `ffmpeg -i`)."""
    proc = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True)
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", proc.stderr)
    if not m:
        raise RuntimeError(f"could not read video size from ffmpeg output for {path}")
    return int(m.group(1)), int(m.group(2))


def read_gray(ffmpeg: str, path: str, width: int = 480) -> Iterator[np.ndarray]:
    """Yield frames as float32 grey arrays (0..255), downscaled to `width` (even height)."""
    w0, h0 = video_size(ffmpeg, path)
    w = min(width, w0)
    h = int(round(h0 * w / w0 / 2)) * 2
    cmd = [ffmpeg, "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=area,format=gray",
           "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = w * h
    assert proc.stdout is not None
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, dtype=np.uint8).reshape(h, w).astype(np.float32)
    finally:
        proc.stdout.close()
        proc.wait()


def write_png(path: str, rgb: np.ndarray) -> None:
    """Write an HxWx3 uint8 array as PNG using only zlib."""
    rgb = np.ascontiguousarray(rgb, dtype=np.uint8)
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
