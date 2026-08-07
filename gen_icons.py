import struct, zlib, sys, os

def png_chunk(typ, data):
    return struct.pack('>I', len(data)) + typ + data + struct.pack('>I', zlib.crc32(typ+data) & 0xffffffff)

def save_png(path, width, height, rgba):
    raw = b''.join(b'\x00' + bytes(rgba[y*width*4:(y+1)*width*4]) for y in range(height))
    compressed = zlib.compress(raw)
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    data = png_chunk(b'IHDR', ihdr) + png_chunk(b'IDAT', compressed) + png_chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + data)
    print('saved', path)

def make_icon(size, name):
    W = H = size
    img = bytearray(W*H*4)

    def set_pixel(x, y, color):
        if 0 <= x < W and 0 <= y < H:
            idx = (y*W+x)*4
            img[idx:idx+4] = color

    def fill(color):
        for y in range(H):
            for x in range(W):
                set_pixel(x, y, color)

    def circle(cx, cy, r, color):
        r2 = r*r
        for y in range(max(0, cy-r), min(H, cy+r+1)):
            dy = y - cy
            dx = int((r2 - dy*dy)**0.5)
            for x in range(max(0, cx-dx), min(W, cx+dx+1)):
                set_pixel(x, y, color)

    def quad_bezier(p0, p1, p2, color, width=2):
        last = None
        for i in range(101):
            t = i/100.0
            x = int((1-t)**2*p0[0] + 2*(1-t)*t*p1[0] + t**2*p2[0])
            y = int((1-t)**2*p0[1] + 2*(1-t)*t*p1[1] + t**2*p2[1])
            if last != (x, y):
                for dy in range(-width//2, width//2+1):
                    for dx in range(-width//2, width//2+1):
                        set_pixel(x+dx, y+dy, color)
                last = (x, y)

    # soft cream/peach background, fills full square
    fill([255, 228, 205, 255])

    # outer rounded-blob highlight ring (slightly lighter)
    circle(W//2, H//2, int(size*0.48), [255, 240, 225, 255])

    # main face circle
    face_r = int(size*0.38)
    circle(W//2, int(H*0.52), face_r, [255, 232, 200, 255])

    # closed happy eyes (upward arcs)
    eye_y = int(H*0.46)
    lw = max(2, size//32)
    left_eye = [(int(W*0.37), eye_y), (int(W*0.42), eye_y - size//22), (int(W*0.47), eye_y)]
    right_eye = [(int(W*0.53), eye_y), (int(W*0.58), eye_y - size//22), (int(W*0.63), eye_y)]
    quad_bezier(left_eye[0], left_eye[1], left_eye[2], [120, 80, 60, 255], lw)
    quad_bezier(right_eye[0], right_eye[1], right_eye[2], [120, 80, 60, 255], lw)

    # rosy cheeks
    blush_r = max(4, size//18)
    circle(int(W*0.32), int(H*0.55), blush_r, [255, 170, 170, 160])
    circle(int(W*0.68), int(H*0.55), blush_r, [255, 170, 170, 160])

    # big smile (filled downward semi-ellipse)
    smile_cx, smile_cy = W//2, int(H*0.58)
    smile_rx, smile_ry = int(W*0.15), int(H*0.08)
    for y in range(smile_cy, smile_cy + smile_ry + 1):
        dy = y - smile_cy
        xspan = int(smile_rx * ((1 - (dy/smile_ry)**2)**0.5))
        for x in range(smile_cx - xspan, smile_cx + xspan + 1):
            set_pixel(x, y, [120, 80, 60, 255])

    # small nose dot
    circle(W//2, int(H*0.525), max(1, size//55), [120, 80, 60, 255])

    save_png(name, W, H, img)

make_icon(192, 'icon-192.png')
make_icon(512, 'icon-512.png')
print('done')
