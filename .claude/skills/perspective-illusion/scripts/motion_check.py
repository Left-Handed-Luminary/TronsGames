#!/usr/bin/env python3
"""Check a loop for freezes, stutter and a visible seam.

    python3 motion_check.py final.mp4 [--ffmpeg ffmpeg] [--freeze 0.04] [--min-run 6]

Per-frame motion is the mean |frame[i+1] - frame[i]| (grey levels, downscaled).
  freeze   a run of >= --min-run steps with motion below --freeze (holds should drift)
  stutter  a step far above or below its neighbours while they move (dropped,
           doubled or jumping frames)
  seam     the last->first step compared with the typical step
Exit status 1 if any freeze or stutter is found.
"""
from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field

import numpy as np

from frames import read_gray


@dataclass
class MotionReport:
    steps: np.ndarray
    seam: float
    freezes: list = field(default_factory=list)    # (start, length)
    stutters: list = field(default_factory=list)   # (index, kind, value, local median)

    @property
    def ok(self) -> bool:
        return not self.freezes and not self.stutters


def motion_steps(frames: list[np.ndarray]) -> np.ndarray:
    return np.array([float(np.mean(np.abs(frames[i + 1] - frames[i]))) for i in range(len(frames) - 1)])


def find_freezes(steps: np.ndarray, freeze: float, min_run: int) -> list:
    out, start = [], None
    for i, s in enumerate(list(steps) + [np.inf]):
        if s < freeze:
            start = i if start is None else start
        else:
            if start is not None and i - start >= min_run:
                out.append((start, i - start))
            start = None
    return out


def find_stutters(steps: np.ndarray, ratio: float = 3.0, floor: float = 0.3) -> list:
    """Steps that jump (spike) or drop (dip) against a moving neighbourhood."""
    out = []
    n = len(steps)
    for i in range(n):
        nb = [steps[j] for j in range(max(0, i - 2), min(n, i + 3)) if j != i]
        if len(nb) < 2:
            continue
        med = float(np.median(nb))
        s = float(steps[i])
        if med > floor and s > med * ratio:
            out.append((i, "spike", s, med))
        elif med > floor and s < med / ratio:
            out.append((i, "dip", s, med))
    return out


def analyse(frames: list[np.ndarray], freeze: float = 0.04, min_run: int = 6) -> MotionReport:
    if len(frames) < 3:
        raise ValueError("need at least 3 frames")
    steps = motion_steps(frames)
    seam = float(np.mean(np.abs(frames[0] - frames[-1])))
    return MotionReport(steps, seam, find_freezes(steps, freeze, min_run), find_stutters(steps))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", "ffmpeg"))
    ap.add_argument("--freeze", type=float, default=0.04)
    ap.add_argument("--min-run", type=int, default=6)
    ap.add_argument("--width", type=int, default=320)
    args = ap.parse_args(argv)

    frames = list(read_gray(args.ffmpeg, args.video, args.width))
    rep = analyse(frames, args.freeze, args.min_run)
    med = float(np.median(rep.steps))
    print(f"{len(frames)} frames, motion per step: median {med:.3f}, max {rep.steps.max():.3f}")
    seam_note = "ok" if rep.seam <= max(3 * med, 0.5) else "VISIBLE"
    print(f"loop seam (last->first): {rep.seam:.3f}  [{seam_note}]")
    for start, length in rep.freezes:
        print(f"FREEZE  frames {start}..{start + length}  ({length} steps without motion)")
    for i, kind, v, m in rep.stutters:
        print(f"STUTTER frame {i}: {kind} {v:.3f} vs neighbours {m:.3f}")
    print("OK" if rep.ok else "PROBLEMS FOUND")
    return 0 if rep.ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
