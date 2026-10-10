// Preview pictures of personal rooms: drawn from the room's map and the furniture placed with the map editor,
// and drawn again whenever the room changes. Pictures are kept in DATA_DIR/room-previews and served by the admin UI.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { config } from "./config.js";
import { rooms } from "./db.js";
import { decodePng, encodePng, isPng, type Bitmap } from "./png.js";

export const PREVIEW_DIR = path.join(config.dataDir, "room-previews");

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// ---------- fetching ----------

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Files of the map storage are read over the internal address first (the public one may not be reachable from here). */
function candidates(url: string): string[] {
    const pub = config.publicMapStorageUrl;
    if (pub && url.startsWith(pub + "/")) return [config.internalMapStorageUrl + url.slice(pub.length), url];
    return [url];
}

async function fetchBytes(url: string): Promise<Buffer> {
    let last: unknown;
    for (const u of candidates(url)) {
        try {
            const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
            if (res.ok) return Buffer.from(await res.arrayBuffer());
            last = new Error(`${u}: ${res.status}`);
        } catch (err) {
            last = err;
        }
    }
    throw last instanceof Error ? last : new Error(String(last));
}

/** Short-lived cache for tilesets, furniture images and collections, shared by all rooms. */
const assetCache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = assetCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
    const value = load();
    assetCache.set(key, { at: Date.now(), value });
    value.catch(() => assetCache.delete(key));
    if (assetCache.size > 500) assetCache.delete(assetCache.keys().next().value!);
    return value;
}

const image = (url: string) =>
    cached(`img:${url}`, 30 * 60_000, async () => {
        const bytes = await fetchBytes(url);
        return isPng(bytes) ? decodePng(bytes) : undefined; // other formats are left out of the picture
    });

const json = (url: string, ttl: number) => cached(`json:${url}`, ttl, async () => JSON.parse((await fetchBytes(url)).toString("utf8")) as unknown);

// ---------- drawing ----------

function blank(width: number, height: number): Bitmap {
    return { width, height, data: new Uint8Array(width * height * 4) };
}

/**
 * Draws a w×h part of src (from sx,sy) onto dst at dx,dy with Tiled's flip flags.
 * Diagonal flip swaps x and y before the horizontal and vertical flips, like Tiled does.
 */
function blit(dst: Bitmap, src: Bitmap, sx: number, sy: number, w: number, h: number, dx: number, dy: number, opacity = 1, flipH = false, flipV = false, flipD = false) {
    const ow = flipD ? h : w, oh = flipD ? w : h;
    for (let y = 0; y < oh; y++) {
        const ty = dy + y;
        if (ty < 0 || ty >= dst.height) continue;
        for (let x = 0; x < ow; x++) {
            const tx = dx + x;
            if (tx < 0 || tx >= dst.width) continue;
            let u = flipH ? ow - 1 - x : x;
            let v = flipV ? oh - 1 - y : y;
            if (flipD) [u, v] = [v, u];
            const px = sx + u, py = sy + v;
            if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
            const s = (py * src.width + px) * 4;
            const a = (src.data[s + 3]! / 255) * opacity;
            if (a <= 0) continue;
            const d = (ty * dst.width + tx) * 4;
            const da = dst.data[d + 3]! / 255;
            const oa = a + da * (1 - a);
            for (let c = 0; c < 3; c++) {
                dst.data[d + c] = Math.round((src.data[s + c]! * a + dst.data[d + c]! * da * (1 - a)) / oa);
            }
            dst.data[d + 3] = Math.round(oa * 255);
        }
    }
}

/** Halves the picture (average of 2×2 pixels) until it is at most maxWidth wide. */
function shrink(bitmap: Bitmap, maxWidth: number): Bitmap {
    let cur = bitmap;
    while (cur.width > maxWidth && cur.width >= 2 && cur.height >= 2) {
        const w = cur.width >> 1, h = cur.height >> 1;
        const out = blank(w, h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let r = 0, g = 0, b = 0, a = 0;
                for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
                    const s = ((y * 2 + oy) * cur.width + x * 2 + ox) * 4;
                    const al = cur.data[s + 3]!;
                    r += cur.data[s]! * al;
                    g += cur.data[s + 1]! * al;
                    b += cur.data[s + 2]! * al;
                    a += al;
                }
                const o = (y * w + x) * 4;
                if (a) {
                    out.data[o] = Math.round(r / a);
                    out.data[o + 1] = Math.round(g / a);
                    out.data[o + 2] = Math.round(b / a);
                }
                out.data[o + 3] = Math.round(a / 4);
            }
        }
        cur = out;
    }
    return cur;
}

interface Tileset {
    firstgid: number;
    name: string;
    columns: number;
    tilewidth: number;
    tileheight: number;
    margin: number;
    spacing: number;
    tilecount: number;
    image?: string;
    /** Tilesets made of single images. */
    images: Map<number, string>;
}

async function loadTilesets(tmj: Json, tmjUrl: string): Promise<Tileset[]> {
    const out: Tileset[] = [];
    for (const entry of arr(tmj.tilesets)) {
        let ts = obj(entry);
        let base = tmjUrl;
        const firstgid = num(ts.firstgid, 1);
        if (str(ts.source)) {
            base = new URL(str(ts.source)!, tmjUrl).toString();
            if (!/\.(tsj|json)$/i.test(base)) continue; // .tsx (XML) tilesets are not drawn
            ts = obj(await json(base, 10 * 60_000).catch(() => ({})));
        }
        const images = new Map<number, string>();
        for (const tile of arr(ts.tiles)) {
            const t = obj(tile);
            if (str(t.image)) images.set(num(t.id), new URL(str(t.image)!, base).toString());
        }
        out.push({
            firstgid,
            name: str(ts.name) ?? "",
            columns: Math.max(1, num(ts.columns, 1)),
            tilewidth: num(ts.tilewidth, num(tmj.tilewidth, 32)),
            tileheight: num(ts.tileheight, num(tmj.tileheight, 32)),
            margin: num(ts.margin),
            spacing: num(ts.spacing),
            tilecount: num(ts.tilecount, Number.MAX_SAFE_INTEGER),
            image: str(ts.image) ? new URL(str(ts.image)!, base).toString() : undefined,
            images,
        });
    }
    return out.sort((a, b) => a.firstgid - b.firstgid);
}

function layerData(layer: Json): number[] {
    const data = layer.data;
    if (Array.isArray(data)) return data.map((v) => num(v));
    if (typeof data === "string" && layer.encoding === "base64") {
        let bytes = Buffer.from(data, "base64");
        if (layer.compression === "zlib") bytes = zlib.inflateSync(bytes);
        else if (layer.compression === "gzip") bytes = zlib.gunzipSync(bytes);
        else if (layer.compression) return []; // zstd is not supported
        const out: number[] = [];
        for (let i = 0; i + 4 <= bytes.length; i += 4) out.push(bytes.readUInt32LE(i));
        return out;
    }
    return [];
}

type Step = { kind: "tiles"; layer: Json; opacity: number; ox: number; oy: number } | { kind: "image"; layer: Json; opacity: number; ox: number; oy: number } | { kind: "entities" };

/** Layers in drawing order. Furniture from the map editor goes where WorkAdventure puts players: at "floorLayer". */
function steps(layers: unknown[], opacity = 1, ox = 0, oy = 0, out: Step[] = []): Step[] {
    for (const raw of layers) {
        const layer = obj(raw);
        if (layer.visible === false) continue;
        const op = opacity * num(layer.opacity, 1);
        const x = ox + num(layer.offsetx), y = oy + num(layer.offsety);
        if (layer.type === "group") steps(arr(layer.layers), op, x, y, out);
        else if (layer.type === "tilelayer") out.push({ kind: "tiles", layer, opacity: op, ox: x, oy: y });
        else if (layer.type === "imagelayer") out.push({ kind: "image", layer, opacity: op, ox: x, oy: y });
        else if (layer.type === "objectgroup" && layer.name === "floorLayer" && !out.some((s) => s.kind === "entities")) out.push({ kind: "entities" });
    }
    return out;
}

const FLIP_H = 0x80000000, FLIP_V = 0x40000000, FLIP_D = 0x20000000;

async function drawTiles(canvas: Bitmap, step: Extract<Step, { kind: "tiles" }>, tilesets: Tileset[], mapWidth: number, tw: number, th: number) {
    const data = layerData(step.layer);
    const width = num(step.layer.width, mapWidth);
    for (let i = 0; i < data.length; i++) {
        const raw = data[i]!;
        const gid = raw & 0x1fffffff;
        if (!gid) continue;
        let ts: Tileset | undefined;
        for (const t of tilesets) if (t.firstgid <= gid) ts = t;
        // Special zone tiles (start, exits, collisions) are invisible in the game.
        if (!ts || /special_zones/i.test(ts.name)) continue;
        const id = gid - ts.firstgid;
        if (id >= ts.tilecount) continue;
        const x = (i % width) * tw + step.ox, yBottom = (Math.floor(i / width) + 1) * th + step.oy;
        const single = ts.images.get(id);
        const src = await image(single ?? ts.image ?? "").catch(() => undefined);
        if (!src) continue;
        const w = single ? src.width : ts.tilewidth, h = single ? src.height : ts.tileheight;
        const sx = single ? 0 : ts.margin + (id % ts.columns) * (ts.tilewidth + ts.spacing);
        const sy = single ? 0 : ts.margin + Math.floor(id / ts.columns) * (ts.tileheight + ts.spacing);
        // Tiled anchors bigger tiles at the bottom left of their cell.
        blit(canvas, src, sx, sy, w, h, x, yBottom - h, step.opacity, (raw & FLIP_H) !== 0, (raw & FLIP_V) !== 0, (raw & FLIP_D) !== 0);
    }
}

interface Prefab {
    imagePath: string;
    depthOffset: number;
}

/** All furniture the map editor offers in this room: its collections plus the uploaded "custom entities". */
async function prefabs(wam: Json, wamUrl: string): Promise<Map<string, Prefab>> {
    const urls = arr(wam.entityCollections).map((c) => str(obj(c).url)).filter((u): u is string => !!u).map((u) => new URL(u, wamUrl).toString());
    if (config.publicMapStorageUrl) urls.push(`${config.publicMapStorageUrl}/assets/entities/entities.json`);
    const map = new Map<string, Prefab>();
    for (const url of urls) {
        const collection = obj(await json(url, 60_000).catch(() => ({})));
        const name = str(collection.collectionName) ?? "";
        for (const e of arr(collection.collection)) {
            const entity = obj(e);
            // Collections without ids get them the way WorkAdventure's file migration builds them.
            const id = str(entity.id) ?? `${name}:${str(entity.name)}:${str(entity.color)}:${str(entity.direction)}`;
            const imagePath = str(entity.imagePath);
            if (imagePath) map.set(id, { imagePath: new URL(imagePath, url).toString(), depthOffset: num(entity.depthOffset) });
        }
    }
    return map;
}

async function drawEntities(canvas: Bitmap, wam: Json, wamUrl: string) {
    const entities = Object.values(obj(wam.entities)).map(obj);
    if (!entities.length) return;
    const known = await prefabs(wam, wamUrl);
    const placed: { img: Bitmap; x: number; y: number; depth: number }[] = [];
    for (const e of entities) {
        const ref = obj(e.prefabRef);
        const prefab = known.get(str(ref.id) ?? "");
        if (!prefab) continue;
        const img = await image(prefab.imagePath).catch(() => undefined);
        if (!img) continue;
        const x = Math.round(num(e.x)), y = Math.round(num(e.y));
        placed.push({ img, x, y, depth: y + img.height + prefab.depthOffset });
    }
    placed.sort((a, b) => a.depth - b.depth);
    for (const p of placed) blit(canvas, p.img, 0, 0, p.img.width, p.img.height, p.x, p.y);
}

/** Draws the room: map layers below the players, then the furniture, then the layers above. */
export async function renderRoom(wam: Json, wamUrl: string, tmj: Json, tmjUrl: string): Promise<Bitmap> {
    const tw = num(tmj.tilewidth, 32), th = num(tmj.tileheight, 32);
    const width = Math.min(4096, num(tmj.width) * tw), height = Math.min(4096, num(tmj.height) * th);
    if (!width || !height) throw new Error("map without size");
    const canvas = blank(width, height);
    const tilesets = await loadTilesets(tmj, tmjUrl);
    const order = steps(arr(tmj.layers));
    if (!order.some((s) => s.kind === "entities")) order.push({ kind: "entities" });
    for (const step of order) {
        if (step.kind === "tiles") await drawTiles(canvas, step, tilesets, num(tmj.width), tw, th);
        else if (step.kind === "image") {
            const src = str(step.layer.image) ? await image(new URL(str(step.layer.image)!, tmjUrl).toString()).catch(() => undefined) : undefined;
            if (src) blit(canvas, src, 0, 0, src.width, src.height, Math.round(step.ox), Math.round(step.oy), step.opacity);
        } else await drawEntities(canvas, wam, wamUrl);
    }
    // a solid background, like the dark area around the map in the game
    const out = blank(width, height);
    for (let i = 0; i < out.data.length; i += 4) {
        out.data[i] = 27;
        out.data[i + 1] = 26;
        out.data[i + 2] = 42;
        out.data[i + 3] = 255;
    }
    blit(out, canvas, 0, 0, width, height, 0, 0);
    return shrink(out, 720);
}

// ---------- keeping previews up to date ----------

const hash = (s: string | Buffer, n: number) => crypto.createHash("sha256").update(s).digest("hex").slice(0, n);

interface State {
    checkedAt: number;
    file?: string;
    running?: Promise<string | undefined>;
}
const state = new Map<string, State>();
const CHECK_EVERY = 10_000;

function previewUrl(file: string): string {
    return `${config.publicUrl ?? ""}/files/rooms/${file}`;
}

/** Latest picture on disk for a room (survives restarts). */
function existing(prefix: string): string | undefined {
    try {
        return fs.readdirSync(PREVIEW_DIR).filter((f) => f.startsWith(prefix + "-") && f.endsWith(".png")).sort((a, b) => fs.statSync(path.join(PREVIEW_DIR, b)).mtimeMs - fs.statSync(path.join(PREVIEW_DIR, a)).mtimeMs)[0];
    } catch {
        return undefined;
    }
}

async function refresh(roomPath: string, prefix: string): Promise<string | undefined> {
    const wamUrl = `${config.publicMapStorageUrl ?? config.internalMapStorageUrl}/${encodePath(roomPath)}`;
    const wamText = (await fetchBytes(`${config.internalMapStorageUrl}/${encodePath(roomPath)}`)).toString("utf8");
    const wam = obj(JSON.parse(wamText));
    const mapUrl = str(wam.mapUrl);
    if (!mapUrl) throw new Error("room without map");
    const tmjUrl = new URL(mapUrl, wamUrl).toString();
    const tmjText = (await fetchBytes(tmjUrl)).toString("utf8");
    // Same map and same furniture: same picture.
    const file = `${prefix}-${hash(wamText + "\n" + tmjText, 12)}.png`;
    const target = path.join(PREVIEW_DIR, file);
    if (fs.existsSync(target)) return file;
    const bitmap = await renderRoom(wam, wamUrl, obj(JSON.parse(tmjText)), tmjUrl);
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    fs.writeFileSync(target + ".tmp", encodePng(bitmap));
    fs.renameSync(target + ".tmp", target);
    for (const old of fs.readdirSync(PREVIEW_DIR)) {
        if (old.startsWith(prefix + "-") && old !== file) fs.rmSync(path.join(PREVIEW_DIR, old), { force: true });
    }
    console.info(`room preview of ${roomPath} drawn`);
    return file;
}

/**
 * URL of the room's current preview. Checks for changes at most every 10 seconds and waits up to
 * `wait` ms for a new picture; if drawing takes longer, the previous picture is returned meanwhile.
 */
export async function roomPreview(roomPath: string, wait = 4000): Promise<string | undefined> {
    const prefix = hash(roomPath, 16);
    let s = state.get(roomPath);
    if (!s) state.set(roomPath, (s = { checkedAt: 0, file: existing(prefix) }));
    if (!s.running && Date.now() - s.checkedAt > CHECK_EVERY) {
        s.checkedAt = Date.now();
        const st = s;
        st.running = refresh(roomPath, prefix)
            .then((file) => (st.file = file ?? st.file))
            .catch((err) => {
                console.warn(`room preview of ${roomPath} failed: ${err instanceof Error ? err.message : err}`);
                return st.file;
            })
            .finally(() => (st.running = undefined));
    }
    if (s.running && wait > 0) await Promise.race([s.running, new Promise((r) => setTimeout(r, wait))]);
    return s.file ? previewUrl(s.file) : undefined;
}

/** Personal rooms get their own drawn preview instead of the picture of the style they were made from. */
export async function withPreviews<T extends { roomUrl: string; thumbnail?: string | null }>(list: T[], wait = 4000): Promise<T[]> {
    const personal = new Set(rooms.all().filter((r) => r.owner).map((r) => r.path));
    return Promise.all(
        list.map(async (room) => {
            const p = room.roomUrl.replace(/^\/~\//, "");
            if (!personal.has(p)) return room;
            const thumbnail = await roomPreview(p, wait).catch(() => undefined);
            return thumbnail ? { ...room, thumbnail } : room;
        }),
    );
}

/** Path of a preview file for the /files/rooms route, or undefined for unknown names. */
export function previewFile(name: string): string | undefined {
    if (!/^[0-9a-f]{16}-[0-9a-f]{12}\.png$/.test(name)) return undefined;
    const file = path.join(PREVIEW_DIR, name);
    return fs.existsSync(file) ? file : undefined;
}
