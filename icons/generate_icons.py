#!/usr/bin/env python3
"""Generate simple PNG icons for the Tab Audio Recorder extension."""

import struct
import zlib
import math
import os

SIZE = 48


def make_png(width, height, pixel_fn):
    """Create an RGBA PNG file from a pixel function (x, y) -> (r, g, b, a)."""

    def png_chunk(name, data):
        payload = name + data
        crc = zlib.crc32(payload) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + payload + struct.pack('>I', crc)

    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter type: None
        for x in range(width):
            r, g, b, a = pixel_fn(x, y)
            raw += bytes([r, g, b, a])

    compressed = zlib.compress(raw, 9)
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # color type 6 = RGBA

    return (
        b'\x89PNG\r\n\x1a\n'
        + png_chunk(b'IHDR', ihdr)
        + png_chunk(b'IDAT', compressed)
        + png_chunk(b'IEND', b'')
    )


def circle_aa(cx, cy, r, color, x, y):
    """Anti-aliased circle: returns color with alpha based on distance."""
    dx, dy = x - cx, y - cy
    dist = math.sqrt(dx * dx + dy * dy)
    if dist <= r - 0.5:
        return (*color, 255)
    elif dist <= r + 0.5:
        alpha = int((r + 0.5 - dist) * 255)
        return (*color, alpha)
    return (0, 0, 0, 0)


def make_idle():
    """Gray microphone silhouette icon."""
    cx, cy = SIZE / 2, SIZE / 2
    GRAY = (130, 130, 140)

    # Mic body: small rounded rectangle
    body_w, body_h = 14, 18
    body_x0 = cx - body_w / 2
    body_y0 = cy - body_h / 2 - 4
    body_r = body_w / 2  # corner radius = half width → pill shape

    # Stand post and base arc
    post_w = 3
    post_h = 8
    post_x0 = cx - post_w / 2
    post_y0 = cy + body_h / 2 - 4

    base_w = 16
    base_h = 3
    base_x0 = cx - base_w / 2
    base_y0 = post_y0 + post_h - 1

    def pixel(x, y):
        # Mic body (pill shape)
        in_body_rect = (body_x0 + body_r <= x <= body_x0 + body_w - body_r and
                        body_y0 <= y <= body_y0 + body_h)
        in_body_full = body_x0 <= x <= body_x0 + body_w and body_y0 + body_r <= y <= body_y0 + body_h - body_r
        # top and bottom circles of pill
        top_circle = math.sqrt((x - cx) ** 2 + (y - (body_y0 + body_r)) ** 2) <= body_r
        bot_circle = math.sqrt((x - cx) ** 2 + (y - (body_y0 + body_h - body_r)) ** 2) <= body_r

        in_body = in_body_rect or in_body_full or top_circle or bot_circle

        # Stand post
        in_post = (post_x0 <= x <= post_x0 + post_w and
                   post_y0 <= y <= post_y0 + post_h)

        # Base bar
        in_base = (base_x0 <= x <= base_x0 + base_w and
                   base_y0 <= y <= base_y0 + base_h)

        # Arm arc (convex upward arc connecting body bottom to post)
        arm_r = 11
        arm_cx, arm_cy = cx, post_y0
        arm_dist = math.sqrt((x - arm_cx) ** 2 + (y - arm_cy) ** 2)
        in_arm_ring = abs(arm_dist - arm_r) <= 1.5 and y <= arm_cy and arm_cx - arm_r - 1 <= x <= arm_cx + arm_r + 1

        if in_body or in_post or in_base or in_arm_ring:
            return (*GRAY, 255)
        return (0, 0, 0, 0)

    return make_png(SIZE, SIZE, pixel)


def make_recording():
    """Bright red filled circle."""
    cx, cy = SIZE / 2, SIZE / 2
    r = SIZE / 2 - 4
    RED = (220, 50, 50)

    def pixel(x, y):
        return circle_aa(cx, cy, r, RED, x, y)

    return make_png(SIZE, SIZE, pixel)


def make_paused():
    """Two vertical yellow bars on transparent background."""
    bar_w = 9
    bar_h = 24
    gap = 8
    top = (SIZE - bar_h) // 2
    total_w = bar_w * 2 + gap
    left1 = (SIZE - total_w) // 2
    left2 = left1 + bar_w + gap
    bar_r = 3  # corner radius
    YELLOW = (230, 190, 40)

    def rounded_rect(x, y, rx, ry, rw, rh, r):
        # Clamp to rounded corners
        dx = max(rx - x, 0, x - (rx + rw))
        dy = max(ry - y, 0, y - (ry + rh))
        return math.sqrt(dx * dx + dy * dy) <= r

    def pixel(x, y):
        in_bar1 = rounded_rect(x, y, left1, top, bar_w, bar_h, bar_r)
        in_bar2 = rounded_rect(x, y, left2, top, bar_w, bar_h, bar_r)
        if in_bar1 or in_bar2:
            return (*YELLOW, 255)
        return (0, 0, 0, 0)

    return make_png(SIZE, SIZE, pixel)


if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))

    icons = {
        'idle.png': make_idle(),
        'recording.png': make_recording(),
        'paused.png': make_paused(),
    }

    for name, data in icons.items():
        path = os.path.join(script_dir, name)
        with open(path, 'wb') as f:
            f.write(data)
        print(f'Created {name} ({len(data)} bytes)')

    print('Done.')
