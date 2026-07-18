"""Sketchfab texture descrambler. Reverses the GPU-based pixel permutation."""
import numpy as np
from PIL import Image
import sys, os

def mod(i, u):
    y = i // u
    return i - y * u

def min_(a, b):
    return a if a < b else b

def max_(a, b):
    return a if a > b else b

def triangle_sum(y, t, f_):
    """Partial triangle number sum for zigzag indexing."""
    x = min_(y, t)
    n = max_(y, t)
    if f_ < x:
        return f_ * (f_ + 1) // 2
    if f_ < n:
        return x * (x + 1) // 2 + x * (f_ - x)
    r = f_ - n
    return x * (x + 1) // 2 + x * (n - x) + (x - 1) * r - (r - 1) * r // 2

def xy_to_zigzag(y, t, pos):
    """Convert 2D block coordinate to zigzag index."""
    r = min_(y, t)
    n = max_(y, t)
    v = pos[0] + pos[1]
    h = mod(v, 2) == 0
    if v < r:
        if h:
            return triangle_sum(y, t, v) + v - pos[1]
        return triangle_sum(y, t, v) + pos[1]
    if v < n:
        s = t - pos[1] - 1
        if y < t:
            s = r - (y - pos[0])
        if h:
            return triangle_sum(y, t, v) + s
        return triangle_sum(y, t, v) + r - s - 1
    s = t - pos[1] - 1
    e = r + n - v - 1
    if h:
        return triangle_sum(y, t, v) + s
    return triangle_sum(y, t, v) + e - s - 1

def zigzag_to_xy(y, t, x):
    """Convert zigzag index back to 2D block coordinate."""
    import math
    v = min_(y, t)
    r = max_(y, t)
    threshold1 = v * (v + 1) // 2
    threshold2 = threshold1 + v * (r - v)

    if x < threshold1:
        n = int((-1 + (1e-6 + math.sqrt(8 * x + 1))) // 1) // 2
        h = x - triangle_sum(y, t, n)
        s = mod(n, 2) == 0
        if s:
            return (h, n - h)
        return (n - h, h)

    if x < threshold2:
        x2 = x - threshold1
        n = v + x2 // v
        s = mod(x2, v)
        h = mod(n, 2) == 0
        g = n - v + s + 1
        e = v - s - 1
        S = n - s
        T = s
        if y > t:
            if h:
                return (g, e)
            return (S, T)
        if h:
            return (T, S)
        return (e, g)

    n2 = v * (v - 1) // 2 - (x - threshold2) - 1
    import math
    s2 = int((-1 + math.sqrt(8 * n2 + 1)) // 1) // 2
    n = r + v - s2 - 2
    h2 = x - triangle_sum(y, t, n)
    g2 = mod(n, 2) == 0
    e2 = v + r - n - 1
    if g2:
        h2 = e2 - h2 - 1
    S2 = n + h2 - y + 1
    return (n - S2, S2)

def pixel_to_block_index(vx, vy, block_w, block_h):
    """Map pixel position to flat block+intra-block index."""
    bx = vx // 8
    by = vy // 8
    block_idx = xy_to_zigzag(block_w, block_h, (bx, by))
    rotation = mod(block_idx, 4)
    px = mod(vx, 8)
    py = mod(vy, 8)
    if rotation == 1:
        px = 7 - px
    elif rotation == 2:
        px, py = py, px
    elif rotation == 3:
        px, py = 7 - py, px
    return block_idx * 64 + px + py * 8

def flat_index_to_pixel(idx, w, h):
    """Map flat descrambled index back to pixel position."""
    total = w * h
    idx = mod(idx, total)
    block_w = w // 8
    block_h = h // 8
    block_idx = idx // 64
    intra = idx - block_idx * 64
    intra_y = intra // 8
    intra_x = intra - intra_y * 8
    rotation = mod(block_idx, 4)
    bpos = zigzag_to_xy(block_w, block_h, block_idx)
    px = bpos[0] * 8
    py = bpos[1] * 8
    if rotation == 0:
        px += intra_x
        py += intra_y
    elif rotation == 1:
        px += 7 - intra_x
        py += intra_y
    elif rotation == 2:
        px += intra_y
        py += intra_x
    elif rotation == 3:
        px += intra_y
        py += 7 - intra_x
    return (px, py)

def descramble_texture(img_array, pk):
    """Descramble a Sketchfab texture using the pk parameter."""
    h, w = img_array.shape[:2]
    channels = img_array.shape[2] if len(img_array.shape) > 2 else 1
    total = w * h
    offset = (-pk * 64) % total

    result = np.zeros_like(img_array)

    for y in range(h):
        for x in range(w):
            # Forward: find where this output pixel comes from
            flat_idx = pixel_to_block_index(x, y, w // 8, h // 8)
            shifted = flat_idx + offset
            if shifted >= total:
                shifted -= total
            if shifted < 0:
                shifted += total
            src = flat_index_to_pixel(shifted, w, h)
            if 0 <= src[0] < w and 0 <= src[1] < h:
                result[y, x] = img_array[src[1], src[0]]

    return result

def descramble_fast(img_array, pk):
    """Vectorized descramble using precomputed lookup table."""
    h, w = img_array.shape[:2]
    total = w * h
    offset = (-pk * 64) % total

    # Build lookup: for each output pixel (x,y), find source pixel
    # This is the inverse of the scramble
    lut_x = np.zeros((h, w), dtype=np.int32)
    lut_y = np.zeros((h, w), dtype=np.int32)

    for y in range(h):
        for x in range(w):
            flat_idx = pixel_to_block_index(x, y, w // 8, h // 8)
            shifted = (flat_idx + offset) % total
            src = flat_index_to_pixel(shifted, w, h)
            lut_x[y, x] = src[0]
            lut_y[y, x] = src[1]

    return img_array[lut_y, lut_x]

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python descramble.py <input> <pk> <output>")
        print("  pk = the .pk value from the osgjs image metadata")
        sys.exit(1)

    input_path = sys.argv[1]
    pk = int(sys.argv[2])
    output_path = sys.argv[3]

    print(f"Loading {input_path}...")
    img = np.array(Image.open(input_path))
    h, w = img.shape[:2]
    print(f"  Size: {w}x{h}, pk={pk}")
    print(f"  Offset: {(pk * 64) % (w * h)}")

    print("Descrambling...")
    result = descramble_fast(img, pk)

    Image.fromarray(result).save(output_path)
    print(f"Saved to {output_path}")
