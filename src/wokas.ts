import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { cosmeticSets, cosmeticTextureId, cosmeticUrl, cosmeticsFor, hasCosmetic, cosmetics, type Cosmetic, type CosmeticViewer } from "./cosmetics.js";

// Same order WorkAdventure uses to stack the layers of a woka.
export const WOKA_PARTS = ["woka", "body", "eyes", "hair", "clothes", "hat", "accessory"] as const;

interface WokaTexture {
    id: string;
    name: string;
    url: string;
    position?: number;
}
interface WokaCollection {
    name: string;
    position?: number;
    textures: WokaTexture[];
}
interface WokaPart {
    required?: boolean;
    collections: WokaCollection[];
}
export type WokaList = Record<string, WokaPart>;

export interface WokaDetail {
    id: string;
    url: string;
}

export interface Viewer {
    identifier: string;
    tags: string[];
}

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const official: WokaList = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "woka.json"), "utf8"));

// WorkAdventure ships ~290 Pipoya characters but its default list only offers 24 of them.
// The others are added as extra collections (files served by WorkAdventure itself).
const PIPOYA: Record<string, string[]> = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "pipoya.json"), "utf8"));
const PIPOYA_NAMES: Record<string, Record<"de" | "en", string>> = {
    male: { de: "Männer", en: "Men" },
    female: { de: "Frauen", en: "Women" },
    school: { de: "Schule", en: "School" },
    animals: { de: "Tiere", en: "Animals" },
};
const pipoyaId = (file: string) => "pipoya-" + file.replace(/\.png$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

// Recoloured parts for the woka builder (more hair and eye colours, glasses), made from
// WorkAdventure's own customisation sprites and served by the admin UI under /files/parts/.
interface PartCollection {
    key: string;
    names: Record<"de" | "en", string>;
    files: string[];
    bundled?: string[];
}
const PARTS: Record<string, PartCollection[]> = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "parts", "parts.json"), "utf8"));
export const PARTS_DIR = path.join(DATA_DIR, "parts");
const BUNDLED_DIR: Record<string, string> = { eyes: "character_eyes", hair: "character_hairs" };

function addParts(list: WokaList, lang: "de" | "en"): void {
    if (!config.publicUrl) return;
    for (const [part, cols] of Object.entries(PARTS)) {
        const target = (list[part] ??= { collections: [] });
        let position = 1;
        for (const col of cols) {
            const textures = [
                ...col.files.map((file) => ({ id: "part-" + file.replace(/\.png$/, ""), name: file.replace(/\.png$/, ""), url: `${config.publicUrl}/files/parts/${file}` })),
                ...(col.bundled ?? []).map((file) => ({ id: "part-wa-" + file.replace(/\.png$/, ""), name: file.replace(/\.png$/, ""), url: `resources/customisation/${BUNDLED_DIR[part]}/${file}` })),
            ].map((tex, i) => ({ ...tex, position: i }));
            target.collections.push({ name: col.names[lang], position: position++, textures });
        }
    }
}

function addPipoya(list: WokaList, lang: "de" | "en"): void {
    const part = (list.woka ??= { collections: [] });
    let position = 1;
    for (const [group, files] of Object.entries(PIPOYA)) {
        part.collections.push({
            name: PIPOYA_NAMES[group]?.[lang] ?? group,
            position: position++,
            textures: files.map((file, i) => ({ id: pipoyaId(file), name: file.replace(/\.png$/, ""), url: `resources/characters/pipoya/${file}`, position: i })),
        });
    }
}

// Cosmetics (seasonal, roles, uploaded avatars and parts): one collection per set, only with what the player has.
function addCosmetics(list: WokaList, viewer: CosmeticViewer, lang: "de" | "en"): void {
    if (!config.publicUrl) return;
    const own = cosmeticsFor(viewer);
    cosmeticSets.forEach((set, index) => {
        for (const item of own.filter((c) => c.set === set.key && c.part !== "companion")) {
            const part = (list[item.part] ??= { collections: [] });
            let collection = part.collections.find((c) => c.name === set.names[lang]);
            if (!collection) {
                collection = { name: set.names[lang], position: 100 + index, textures: [] };
                part.collections.push(collection);
            }
            collection.textures.push({ id: cosmeticTextureId(item), name: item.names[lang], url: cosmeticUrl(item), position: collection.textures.length });
        }
    });
}

/** The woka list a given user may choose from: all official wokas plus the cosmetics they have (uploaded ones included). */
export function wokaListFor(viewer: Viewer, lang: "de" | "en" = "en"): WokaList {
    const list: WokaList = structuredClone(official);
    addPipoya(list, lang);
    addParts(list, lang);
    addCosmetics(list, viewer, lang);
    return list;
}

/**
 * Resolves texture ids to their URLs, in layer order.
 * Returns undefined if any id is unknown or not allowed for this user.
 */
export function wokaDetailsFor(viewer: Viewer, ids: string[]): WokaDetail[] | undefined {
    if (ids.length === 0) return undefined;
    const list = wokaListFor(viewer);
    const wanted = new Set(ids);
    const details: WokaDetail[] = [];
    for (const part of [...WOKA_PARTS, ...Object.keys(list).filter((p) => !(WOKA_PARTS as readonly string[]).includes(p))]) {
        for (const collection of list[part]?.collections ?? []) {
            for (const texture of collection.textures) {
                if (wanted.has(texture.id)) {
                    details.push({ id: texture.id, url: texture.url });
                    wanted.delete(texture.id);
                }
            }
        }
    }
    return wanted.size === 0 ? details : undefined;
}

// ---------- Companions ----------

interface CompanionTexture {
    id: string;
    name: string;
    url: string;
    behavior?: string;
}
interface CompanionCollection {
    name: string;
    position?: number;
    textures: CompanionTexture[];
}

export const companions: CompanionCollection[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "companions.json"), "utf8"));

/** Companions a player may choose: the official ones plus the unlocked cosmetic companions. */
export function companionsFor(viewer: CosmeticViewer, lang: "de" | "en" = "en"): CompanionCollection[] {
    const list = structuredClone(companions);
    if (!config.publicUrl) return list;
    // WorkAdventure only shows one collection at a time and the switch is easy to miss, so the unlocked
    // companions go right after the official ones in the first collection.
    const own = cosmeticsFor(viewer).filter((c) => c.part === "companion");
    const order = (c: Cosmetic) => cosmeticSets.findIndex((s) => s.key === c.set);
    list[0]?.textures.push(
        ...own
            .sort((a, b) => order(a) - order(b))
            .map((item) => ({ id: cosmeticTextureId(item), name: item.names[lang], url: cosmeticUrl(item), ...(item.behavior ? { behavior: item.behavior } : {}) })),
    );
    return list;
}

/** A companion texture, or undefined if it does not exist or the player may not use it. */
export function companionDetail(id: string, viewer: CosmeticViewer): { id: string; url: string } | undefined {
    for (const collection of companions) {
        const texture = collection.textures.find((t) => t.id === id);
        if (texture) return { id: texture.id, url: texture.url };
    }
    const item = cosmetics.find((c) => c.part === "companion" && cosmeticTextureId(c) === id);
    if (item && config.publicUrl && hasCosmetic(viewer, item)) return { id, url: cosmeticUrl(item) };
    return undefined;
}
