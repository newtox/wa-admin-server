// Small PNG reader and writer (no extra packages): enough for tilesets, furniture images and room previews.
import zlib from "node:zlib";

export interface Bitmap {
    width: number;
    height: number;
    /** RGBA, 4 bytes per pixel, rows top to bottom. */
    data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(bytes: Uint8Array): boolean {
    return bytes.length > 8 && Buffer.from(bytes.subarray(0, 8)).equals(SIGNATURE);
}

/** Decodes a PNG into RGBA. Throws for interlaced or broken files. */
export function decodePng(input: Uint8Array): Bitmap {
    const buf = Buffer.from(input);
    if (!isPng(buf)) throw new Error("not a PNG");
    let pos = 8;
    let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
    let palette: Buffer | undefined;
    let trns: Buffer | undefined;
    const idat: Buffer[] = [];
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString("latin1", pos + 4, pos + 8);
        const body = buf.subarray(pos + 8, pos + 8 + len);
        pos += 12 + len;
        if (type === "IHDR") {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            depth = body[8]!;
            colorType = body[9]!;
            interlace = body[12]!;
        } else if (type === "PLTE") palette = body;
        else if (type === "tRNS") trns = body;
        else if (type === "IDAT") idat.push(body);
        else if (type === "IEND") break;
    }
    if (!width || !height || width * height > 16_000_000) throw new Error("bad PNG size");
    if (interlace) throw new Error("interlaced PNG not supported");
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) throw new Error("bad PNG color type");
    const bpp = Math.max(1, (channels * depth) >> 3); // bytes per pixel for filtering
    const stride = (width * channels * depth + 7) >> 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    if (raw.length < (stride + 1) * height) throw new Error("truncated PNG");

    // undo the row filters
    const rows = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!;
        const src = y * (stride + 1) + 1;
        const dst = y * stride;
        for (let x = 0; x < stride; x++) {
            const cur = raw[src + x]!;
            const a = x >= bpp ? rows[dst + x - bpp]! : 0;
            const b = y > 0 ? rows[dst - stride + x]! : 0;
            const c = x >= bpp && y > 0 ? rows[dst - stride + x - bpp]! : 0;
            let v: number;
            if (filter === 0) v = cur;
            else if (filter === 1) v = cur + a;
            else if (filter === 2) v = cur + b;
            else if (filter === 3) v = cur + ((a + b) >> 1);
            else {
                const p = a + b - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            }
            rows[dst + x] = v & 0xff;
        }
    }

    // samples as 8 bit
    const sample = (y: number, i: number): number => {
        const row = y * stride;
        if (depth === 8) return rows[row + i]!;
        if (depth === 16) return rows[row + i * 2]!;
        const bit = i * depth;
        const v = (rows[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
    };
    // transparent colour of grey/RGB images, scaled like the samples
    const key = (i: number) => {
        if (!trns || trns.length < i * 2 + 2) return -1;
        const v = trns.readUInt16BE(i * 2);
        return depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / ((1 << depth) - 1));
    };

    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            let r: number, g: number, b: number, alpha = 255;
            if (colorType === 3) {
                const idx = sample(y, x);
                r = palette?.[idx * 3] ?? 0;
                g = palette?.[idx * 3 + 1] ?? 0;
                b = palette?.[idx * 3 + 2] ?? 0;
                alpha = trns && idx < trns.length ? trns[idx]! : 255;
            } else if (colorType === 0 || colorType === 4) {
                r = g = b = sample(y, x * channels);
                if (colorType === 4) alpha = sample(y, x * channels + 1);
                else if (trns && r === key(0)) alpha = 0;
            } else {
                r = sample(y, x * channels);
                g = sample(y, x * channels + 1);
                b = sample(y, x * channels + 2);
                if (colorType === 6) alpha = sample(y, x * channels + 3);
                else if (trns && r === key(0) && g === key(1) && b === key(2)) alpha = 0;
            }
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
            out[o + 3] = alpha;
        }
    }
    return { width, height, data: out };
}

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(bytes: Buffer): number {
    let c = -1;
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
}

/** Encodes RGBA as PNG. */
export function encodePng(bitmap: Bitmap): Buffer {
    const { width, height, data } = bitmap;
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
