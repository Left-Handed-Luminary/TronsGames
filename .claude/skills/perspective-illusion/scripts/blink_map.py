#!/usr/bin/env python3
"""Count pixels that blink in nearly still frames, and save a heat map.

    python3 blink_map.py <ffmpeg> final.mp4 blink.png [--thresh 14] [--still 2.0] [--width 480]

A pixel "blinks" at frame b of a triple (a, b, c) when b jumps away from BOTH
neighbours in the same direction while a and c agree, i.e. it flashes for one
frame. Only triples where the whole frame is nearly still are counted (mean
|a - c| below --still), because during camera moves everything changes anyway.

Compare the printed count before and after a change. Judge finals only:
previews shimmer by design. What remains should be intended motion.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from typing import Iterable

import numpy as np

from frames import read_gray, write_png


@dataclass
class BlinkResult:
    counts: np.ndarray      # per-pixel blink count
    total: int              # sum of counts
    still_triples: int      # how many triples were nearly still
    triples: int            # all triples seen


def blink_mask(a: np.ndarray, b: np.ndarray, c: np.ndarray, thresh: float) -> np.ndarray:
    """Boolean mask of pixels where b flashes away from a and c, which agree."""
    da = b - a
    dc = b - c
    return (np.abs(da) > thresh) & (np.abs(dc) > thresh) & (np.sign(da) == np.sign(dc)) \
        & (np.abs(a - c) < thresh * 0.5)


def is_still(a: np.ndarray, c: np.ndarray, still: float) -> bool:
    return float(np.mean(np.abs(a - c))) < still


def blink_counts(frames: Iterable[np.ndarray], thresh: float = 14.0, still: float = 2.0) -> BlinkResult:
    counts = None
    window: list[np.ndarray] = []
    still_n = 0
    n = 0
    for f in frames:
        window.append(f)
        if len(window) < 3:
            continue
        if len(window) > 3:
            window.pop(0)
        a, b, c = window
        if counts is None:
            counts = np.zeros(b.shape, dtype=np.int32)
        n += 1
        if is_still(a, c, still):
            still_n += 1
            counts += blink_mask(a, b, c, thresh)
    if counts is None:
        raise ValueError("need at least 3 frames")
    return BlinkResult(counts, int(counts.sum()), still_n, n)


def heatmap(counts: np.ndarray, background: np.ndarray | None = None) -> np.ndarray:
    """Red-yellow heat over a dimmed grey frame."""
    h, w = counts.shape
    base = np.zeros((h, w, 3), dtype=np.float32)
    if background is not None:
        base[:] = (background[..., None] * 0.35)
    v = np.clip(np.log1p(counts) / np.log1p(max(1, int(counts.max()))), 0, 1)[..., None]
    heat = np.concatenate([np.ones_like(v), v, np.zeros_like(v)], axis=2) * 255
    mask = (counts > 0)[..., None]
    return np.where(mask, base * (1 - 0.85) + heat * 0.85, base).astype(np.uint8)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ffmpeg")
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--thresh", type=float, default=14.0, help="grey-level jump that counts as a blink")
    ap.add_argument("--still", type=float, default=2.0, help="mean |a-c| below which a triple is 'still'")
    ap.add_argument("--width", type=int, default=480)
    args = ap.parse_args(argv)

    first: list[np.ndarray] = []

    def tap(it):
        for f in it:
            if not first:
                first.append(f)
            yield f

    res = blink_counts(tap(read_gray(args.ffmpeg, args.video, args.width)), args.thresh, args.still)
    write_png(args.out, heatmap(res.counts, first[0] if first else None))
    px = int((res.counts > 0).sum())
    print(f"blink count {res.total} ({px} pixels) over {res.still_triples}/{res.triples} still triples -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
