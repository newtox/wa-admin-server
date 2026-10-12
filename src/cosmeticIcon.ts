// Still picture of an uploaded cosmetic for the admin pages, like tools/gen_cosmetics.py makes for the bundled ones:
// the standing frame of each direction (down, left, right, up) side by side, 128 x 32, the item alone, centred
// and enlarged by a whole factor when it is small. All four use the same crop and size, so it does not jump.
import { decodePng, encodePng, type Bitmap } from "./png.js";

const FRAME = 32;

export function cosmeticIconPng(sheet: Uint8Array): Buffer {
    const src = decodePng(sheet);
    const alpha = (x: number, y: number) => src.data[(y * src.width + x) * 4 + 3]!;
    // bounding box over the standing frames (middle column) of the four directions
    let x0 = FRAME, y0 = FRAME, x1 = -1, y1 = -1;
    for (let row = 0; row < 4; row++) {
        for (let y = 0; y < FRAME; y++) {
            for (let x = 0; x < FRAME; x++) {
                if (alpha(FRAME + x, row * FRAME + y) === 0) continue;
                x0 = Math.min(x0, x);
                y0 = Math.min(y0, y);
                x1 = Math.max(x1, x);
                y1 = Math.max(y1, y);
            }
        }
    }
    const out: Bitmap = { width: 4 * FRAME, height: FRAME, data: new Uint8Array(4 * FRAME * FRAME * 4) };
    if (x1 < 0) return encodePng(out);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const k = Math.max(1, Math.floor(28 / Math.max(w, h)));
    const left = Math.floor((FRAME - w * k) / 2);
    const top = Math.floor((FRAME - h * k) / 2);
    for (let row = 0; row < 4; row++) {
        for (let y = 0; y < h * k; y++) {
            for (let x = 0; x < w * k; x++) {
                const sx = FRAME + x0 + Math.floor(x / k);
                const sy = row * FRAME + y0 + Math.floor(y / k);
                const from = (sy * src.width + sx) * 4;
                const to = ((top + y) * out.width + row * FRAME + left + x) * 4;
                out.data.set(src.data.subarray(from, from + 4), to);
            }
        }
    }
    return encodePng(out);
}
