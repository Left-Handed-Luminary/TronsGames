"""Unit tests for scripts/blink_map.py and scripts/motion_check.py.

    python3 -m unittest discover -s tests -p 'test_*.py'
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zlib

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import blink_map  # noqa: E402
import motion_check  # noqa: E402
from frames import read_gray, write_png  # noqa: E402


def still_frames(n, h=24, w=32, value=100.0):
    return [np.full((h, w), value, dtype=np.float32) for _ in range(n)]


class BlinkTests(unittest.TestCase):
    def test_static_video_has_no_blinks(self):
        res = blink_map.blink_counts(still_frames(10))
        self.assertEqual(res.total, 0)
        self.assertEqual(res.still_triples, 8)

    def test_single_frame_flash_is_counted_once(self):
        frames = still_frames(7)
        frames[3] = frames[3].copy()
        frames[3][5, 6] = 200
        res = blink_map.blink_counts(frames)
        self.assertEqual(res.total, 1)
        self.assertEqual(res.counts[5, 6], 1)

    def test_step_change_is_not_a_blink(self):
        frames = still_frames(4) + still_frames(4)
        for f in frames[4:]:
            f[2, 2] = 200
        self.assertEqual(blink_map.blink_counts(frames).total, 0)

    def test_moving_frames_are_ignored(self):
        rng = np.random.default_rng(1)
        frames = [rng.uniform(0, 255, (24, 32)).astype(np.float32) for _ in range(6)]
        res = blink_map.blink_counts(frames)
        self.assertEqual(res.still_triples, 0)
        self.assertEqual(res.total, 0)

    def test_needs_three_frames(self):
        with self.assertRaises(ValueError):
            blink_map.blink_counts(still_frames(2))

    def test_heatmap_shape_and_hot_pixel(self):
        counts = np.zeros((4, 5), dtype=np.int32)
        counts[1, 2] = 3
        img = blink_map.heatmap(counts, np.full((4, 5), 100.0))
        self.assertEqual(img.shape, (4, 5, 3))
        self.assertGreater(img[1, 2, 0], img[0, 0, 0])


class MotionTests(unittest.TestCase):
    def moving(self, n, speed=0.5, offset=0.0):
        """A sine pattern sliding sideways at `speed` px/frame."""
        xs = np.arange(32, dtype=np.float32)
        return [np.tile(np.sin((xs + offset + i * speed) / 3) * 60 + 120, (24, 1)) for i in range(n)]

    def test_smooth_motion_is_ok(self):
        rep = motion_check.analyse(self.moving(30))
        self.assertTrue(rep.ok, (rep.freezes, rep.stutters))

    def test_freeze_detected(self):
        frames = self.moving(10) + [self.moving(10)[-1]] * 10 + self.moving(10)
        rep = motion_check.analyse(frames, min_run=6)
        self.assertTrue(rep.freezes)
        self.assertFalse(rep.ok)

    def test_duplicated_frame_is_a_dip(self):
        frames = self.moving(20)
        frames.insert(10, frames[9])
        kinds = [k for _, k, _, _ in motion_check.analyse(frames).stutters]
        self.assertIn("dip", kinds)

    def test_jump_is_a_spike(self):
        # 10 smooth frames, then the pattern jumps 4 px ahead (8 frames' worth) in one step
        frames = self.moving(10) + self.moving(10, offset=10 * 0.5 + 4.0)
        kinds = [k for _, k, _, _ in motion_check.analyse(frames).stutters]
        self.assertIn("spike", kinds)

    def test_ease_into_hold_is_not_a_stutter(self):
        steps = np.array([12.4, 10.2, 7.2, 3.1, 0.6, 1.4, 2.0, 2.5, 3.2])   # measured on a real ease
        self.assertEqual(motion_check.find_stutters(steps), [])
        stop = np.array([25.4, 24.0, 21.0, 12.8, 0.8, 0.04, 0.04, 0.05])
        self.assertEqual(motion_check.find_stutters(stop), [])

    def test_find_freezes_runs(self):
        steps = np.array([1, 0, 0, 0, 1, 0, 0])
        self.assertEqual(motion_check.find_freezes(steps, 0.5, 3), [(1, 3)])
        self.assertEqual(motion_check.find_freezes(steps, 0.5, 2), [(1, 3), (5, 2)])


class FramesTests(unittest.TestCase):
    def test_write_png_is_valid(self):
        img = np.zeros((3, 4, 3), dtype=np.uint8)
        img[1, 2] = (255, 0, 0)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.png")
            write_png(p, img)
            data = open(p, "rb").read()
        self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
        # decode IDAT and compare the red pixel
        i = data.index(b"IDAT")
        n = int.from_bytes(data[i - 4:i], "big")
        raw = zlib.decompress(data[i + 4:i + 4 + n])
        row = raw[1 * (1 + 12):(2) * (1 + 12)]
        self.assertEqual(row[1 + 2 * 3:1 + 3 * 3], b"\xff\x00\x00")

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_read_gray_and_cli_on_a_real_video(self):
        with tempfile.TemporaryDirectory() as d:
            vid = os.path.join(d, "t.mp4")
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10",
                            "-t", "1.5", "-pix_fmt", "yuv420p", vid], check=True)
            frames = list(read_gray("ffmpeg", vid, 80))
            self.assertEqual(len(frames), 15)
            h, w = frames[0].shape
            self.assertEqual(w, 80)
            self.assertEqual(h % 2, 0)              # even height for the scaler
            self.assertLessEqual(abs(h - 45), 1)    # keeps the 16:9 aspect
            out = os.path.join(d, "b.png")
            self.assertEqual(blink_map.main(["ffmpeg", vid, out]), 0)
            self.assertTrue(os.path.getsize(out) > 0)


if __name__ == "__main__":
    unittest.main()
