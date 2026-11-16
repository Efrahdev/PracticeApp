#!/usr/bin/env python3 -I
"""Compare the screenshots made by svg_render_check.mjs: original page figure vs packaged asset shown as <img>.

Metric: mean absolute colour error over 6x6-pixel blocks (0 = identical). Tolerant of anti-aliasing / sub-pixel shifts.
Calibration (svg_control.mjs, same figures rendered WITHOUT the embedded <style>): broken figures score 100-165,
correct ones score 0.7-2.6, so the pass threshold is 10.   Usage: svg_compare.py <dir>
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

THRESHOLD = 10.0
d = Path(sys.argv[1])
names = json.loads((d / "names.json").read_text())


def blocks(path, k=6):
    a = np.asarray(Image.open(path).convert("RGB"), dtype=float)
    h, w = a.shape[:2]
    h2, w2 = h // k * k, w // k * k
    return a[:h2, :w2].reshape(h2 // k, k, w2 // k, k, 3).mean(axis=(1, 3))


scores = []
for n in names:
    a, b = blocks(d / f"{n}.orig.png"), blocks(d / f"{n}.asset.png")
    scores.append((float(np.abs(a - b).mean()) if a.shape == b.shape else 999.0, n))
scores.sort(reverse=True)
print(f"{len(names)} figures compared; error: max {scores[0][0]:.2f}, median {scores[len(scores)//2][0]:.2f}, min {scores[-1][0]:.2f} (threshold {THRESHOLD})")
for s, n in scores[:5]:
    print(f"  worst: {n} {s:.2f}")
bad = [x for x in scores if x[0] > THRESHOLD]
print("RESULT:", "all 102 figures render the same as in the source page" if not bad else f"{len(bad)} figures differ: {[n for _, n in bad][:10]}")
sys.exit(1 if bad else 0)
