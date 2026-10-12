// Unlockable cosmetics: themed clothes, hats, accessories and companions (data/cosmetics/).
//
// Each item has one unlock rule:
//   everyone              – available to all
//   tags                  – players with one of these roles (admins get everything anyway)
//   season {from, to}     – selectable by everyone in that time of year ("MM-DD"); whoever is online then keeps it
//   manual                – handed out by an admin, e.g. for an event
// Admins can also hand out any other item. Earned and given items are stored in the "unlocks" table,
// so seasonal items stay when the season ends.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { customWokas, db, listCustomWokas, listUsers, users } from "./db.js";
import { cosmeticIconPng } from "./cosmeticIcon.js";
import type { Lang } from "./i18n.js";
import { roleStyle } from "./cards.js";

export type CosmeticPart = "woka" | "body" | "eyes" | "hair" | "clothes" | "hat" | "accessory" | "companion";

export interface Unlock {
    everyone?: boolean;
    tags?: string[];
    season?: { from: string; to: string };
    manual?: boolean;
}

export interface Cosmetic {
    id: string;
    part: CosmeticPart;
    set: string;
    names: Record<Lang, string>;
    behavior?: "cat" | "dog" | "red_panda";
    unlock: Unlock;
    /** Uploaded in the admin UI (stored in DATA_DIR/cosmetics), not part of the bundled catalog. */
    custom?: boolean;
}

interface CosmeticSet {
    key: string;
    names: Record<Lang, string>;
}

export interface CosmeticViewer {
    identifier: string;
    tags: string[];
}

export const COSMETICS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "cosmetics");
/** Cosmetics uploaded in the admin UI: pictures here, the rest in the "custom_cosmetics" table. */
export const CUSTOM_COSMETICS_DIR = path.join(config.dataDir, "cosmetics");
const catalog: { sets: CosmeticSet[]; items: Cosmetic[] } = JSON.parse(fs.readFileSync(path.join(COSMETICS_DIR, "cosmetics.json"), "utf8"));
/** Set for uploaded items that belong to none of the others. */
export const CUSTOM_SET = "custom";
export const cosmeticSets: CosmeticSet[] = [...catalog.sets, { key: CUSTOM_SET, names: { de: "Eigene", en: "Custom" } }];
/** Bundled items followed by the uploaded ones; kept up to date in place by reloadCustomCosmetics(). */
export const cosmetics: Cosmetic[] = [...catalog.items];
/** Everything that can be uploaded: complete characters, the builder's parts and companions. */
export const CUSTOM_PARTS = ["woka", "body", "eyes", "hair", "clothes", "hat", "accessory", "companion"] as const;
export const BEHAVIORS = ["dog", "cat", "red_panda"] as const;

/** File of an item: "hat-crown.png", "companion-bat.png", … */
export const cosmeticFile = (item: Cosmetic) => `${item.part}-${item.id}.png`;
/** Texture id WorkAdventure stores for the item. */
export const cosmeticTextureId = (item: Cosmetic) => `cosmetic-${item.id}`;

/** Short content hash of a file, added to its URL so browsers and WorkAdventure load a redrawn picture at once. */
const versions = new Map<string, string>();
/** Where a cosmetics file lives: bundled ones in data/cosmetics, uploaded ones (custom-…) in DATA_DIR/cosmetics. */
export function cosmeticFilePath(file: string): string {
    return path.join(/^(icon-)?[a-z]+-custom-/.test(file) ? CUSTOM_COSMETICS_DIR : COSMETICS_DIR, file);
}
function version(file: string): string {
    let v = versions.get(file);
    if (v === undefined) {
        try {
            v = crypto.createHash("sha1").update(fs.readFileSync(cosmeticFilePath(file))).digest("hex").slice(0, 10);
        } catch {
            v = "";
        }
        versions.set(file, v);
    }
    return v;
}
const fileUrl = (file: string) => `${config.publicUrl}/files/cosmetics/${file}${version(file) ? `?v=${version(file)}` : ""}`;
export const cosmeticUrl = (item: Cosmetic) => fileUrl(cosmeticFile(item));
/** Still picture of the item alone: standing frame of each direction (down, left, right, up) side by side, 128x32. */
export const cosmeticIconUrl = (item: Cosmetic) => fileUrl(`icon-${cosmeticFile(item)}`);
export const cosmeticById = (id: string) => cosmetics.find((c) => c.id === id);

db.exec(`
    -- One row per player and day they entered a room (season rewards, "everyone online on that day").
    CREATE TABLE IF NOT EXISTS visits (
        identifier TEXT NOT NULL COLLATE NOCASE,
        day        TEXT NOT NULL,
        PRIMARY KEY (identifier, day)
    );
    -- Cosmetics uploaded in the admin UI. names and unlock are JSON like in cosmetics.json.
    CREATE TABLE IF NOT EXISTS custom_cosmetics (
        id         TEXT PRIMARY KEY,
        part       TEXT NOT NULL,
        set_key    TEXT NOT NULL,
        names      TEXT NOT NULL,
        behavior   TEXT,
        unlock     TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    -- Cosmetics a player earned or was given. source: season | manual
    CREATE TABLE IF NOT EXISTS unlocks (
        identifier TEXT NOT NULL COLLATE NOCASE,
        item       TEXT NOT NULL,
        source     TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (identifier, item)
    );
`);

const st = {
    visit: db.prepare("INSERT OR IGNORE INTO visits (identifier, day) VALUES (?, ?)"),
    visitorsOn: db.prepare("SELECT identifier FROM visits WHERE day = ?"),
    grant: db.prepare("INSERT OR IGNORE INTO unlocks (identifier, item, source) VALUES (?, ?, ?)"),
    revoke: db.prepare("DELETE FROM unlocks WHERE identifier = ? AND item = ?"),
    unlocksOf: db.prepare("SELECT item FROM unlocks WHERE identifier = ?"),
    owners: db.prepare("SELECT identifier, source, created_at FROM unlocks WHERE item = ? ORDER BY created_at"),
    customAll: db.prepare("SELECT * FROM custom_cosmetics ORDER BY created_at, id"),
    customSave: db.prepare(`INSERT INTO custom_cosmetics (id, part, set_key, names, behavior, unlock) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET part = excluded.part, set_key = excluded.set_key, names = excluded.names, behavior = excluded.behavior, unlock = excluded.unlock`),
    customDelete: db.prepare("DELETE FROM custom_cosmetics WHERE id = ?"),
    unlocksDelete: db.prepare("DELETE FROM unlocks WHERE item = ?"),
};

// ---------- uploaded cosmetics ----------

/** Rebuilds the uploaded part of `cosmetics` from the database. */
export function reloadCustomCosmetics(): void {
    const rows = st.customAll.all() as Record<string, string | null>[];
    const custom: Cosmetic[] = rows.map((r) => ({
        id: r.id!,
        part: r.part as CosmeticPart,
        set: cosmeticSets.some((x) => x.key === r.set_key) ? r.set_key! : CUSTOM_SET,
        names: JSON.parse(r.names!),
        ...(r.behavior ? { behavior: r.behavior as Cosmetic["behavior"] } : {}),
        unlock: JSON.parse(r.unlock!),
        custom: true,
    }));
    cosmetics.splice(0, cosmetics.length, ...catalog.items, ...custom);
    versions.clear();
}

/** Saves an uploaded item (new or changed). Pictures are written separately with storeCustomCosmeticImage(). */
export function saveCustomCosmetic(item: Cosmetic): void {
    st.customSave.run(item.id, item.part, item.set, JSON.stringify(item.names), item.behavior ?? null, JSON.stringify(item.unlock));
    reloadCustomCosmetics();
}

/** Writes the sheet and its still icon; the old files of the item go (the part may have changed). */
export function storeCustomCosmeticImage(item: Cosmetic, sheet: Buffer, icon: Buffer): void {
    fs.mkdirSync(CUSTOM_COSMETICS_DIR, { recursive: true });
    for (const f of fs.readdirSync(CUSTOM_COSMETICS_DIR)) if (f.endsWith(`-${item.id}.png`)) fs.rmSync(path.join(CUSTOM_COSMETICS_DIR, f));
    fs.writeFileSync(path.join(CUSTOM_COSMETICS_DIR, cosmeticFile(item)), sheet);
    fs.writeFileSync(path.join(CUSTOM_COSMETICS_DIR, `icon-${cosmeticFile(item)}`), icon);
    versions.clear();
}

/** Moves the pictures when the part of an item changes (the part is in the file name). */
export function renameCustomCosmeticFiles(before: Cosmetic, after: Cosmetic): void {
    if (before.part === after.part) return;
    for (const prefix of ["", "icon-"]) {
        const from = path.join(CUSTOM_COSMETICS_DIR, prefix + cosmeticFile(before));
        if (fs.existsSync(from)) fs.renameSync(from, path.join(CUSTOM_COSMETICS_DIR, prefix + cosmeticFile(after)));
    }
    versions.clear();
}

/** Deletes an uploaded item with its pictures and everything handed out of it. */
export function deleteCustomCosmetic(item: Cosmetic): void {
    st.customDelete.run(item.id);
    st.unlocksDelete.run(item.id);
    for (const prefix of ["", "icon-"]) fs.rmSync(path.join(CUSTOM_COSMETICS_DIR, prefix + cosmeticFile(item)), { force: true });
    reloadCustomCosmetics();
}

/** New id for an uploaded item; "custom-" keeps it apart from the bundled ones and marks where its files are. */
export function newCustomCosmeticId(): string {
    return `custom-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Avatars used to be uploaded on a page of their own (table custom_wokas, pictures in DATA_DIR/wokas). They are
 * cosmetics now: each becomes an uploaded item with the same id, "for everyone" or "for roles" stays as it was,
 * and people it was shared with get it handed out. Saved avatars of players are renamed to the new texture ids.
 */
function migrateCustomWokas(): void {
    const old = listCustomWokas();
    if (!old.length) return;
    const wokaDir = path.join(config.dataDir, "wokas");
    for (const w of old) {
        try {
            const sheet = fs.readFileSync(path.join(wokaDir, `${w.id}.png`));
            const unlock: Unlock = w.access.everyone ? { everyone: true } : w.access.tags?.length ? { tags: w.access.tags } : { manual: true };
            const part = ((CUSTOM_PARTS as readonly string[]).includes(w.part) ? w.part : "woka") as CosmeticPart;
            const item: Cosmetic = { id: w.id, part, set: CUSTOM_SET, names: { de: w.name, en: w.name }, unlock, custom: true };
            storeCustomCosmeticImage(item, sheet, cosmeticIconPng(sheet));
            st.customSave.run(item.id, item.part, item.set, JSON.stringify(item.names), null, JSON.stringify(item.unlock));
            for (const person of w.access.users ?? []) st.grant.run(person, item.id, "manual");
            for (const u of listUsers()) {
                if (u.textures?.includes(w.id)) users.setTextures(u.identifier, u.textures.map((t) => (t === w.id ? `cosmetic-${w.id}` : t)));
            }
            customWokas.remove(w.id);
            fs.rmSync(path.join(wokaDir, `${w.id}.png`), { force: true });
            console.info(`avatar ${w.id} ("${w.name}") moved to the cosmetics`);
        } catch (err) {
            console.error(`avatar ${w.id} could not be moved to the cosmetics:`, err);
        }
    }
}

migrateCustomWokas();
reloadCustomCosmetics();

/** Today as "YYYY-MM-DD" in the configured time zone. */
export function today(now = new Date()): string {
    try {
        return new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    } catch {
        return now.toISOString().slice(0, 10);
    }
}

/** Whether "MM-DD" lies in a season; seasons may wrap around New Year ("12-01" to "01-06"). */
export function inSeason(season: { from: string; to: string }, day = today()): boolean {
    const md = day.slice(5);
    return season.from <= season.to ? md >= season.from && md <= season.to : md >= season.from || md <= season.to;
}

const isAdminViewer = (v: CosmeticViewer) => v.tags.includes(config.adminTag);

function earned(identifier: string): Set<string> {
    if (!identifier) return new Set();
    return new Set((st.unlocksOf.all(identifier) as { item: string }[]).map((r) => r.item));
}

/** Whether a player may use an item right now. */
export function hasCosmetic(viewer: CosmeticViewer, item: Cosmetic, own = earned(viewer.identifier)): boolean {
    const u = item.unlock;
    if (u.everyone) return true;
    if (isAdminViewer(viewer)) return true;
    if (u.tags?.some((t) => viewer.tags.includes(t))) return true;
    if (u.season && inSeason(u.season)) return true;
    return own.has(item.id);
}

/** All items a player may use. */
export function cosmeticsFor(viewer: CosmeticViewer): Cosmetic[] {
    const own = earned(viewer.identifier);
    return cosmetics.filter((item) => hasCosmetic(viewer, item, own));
}

/** Items the player keeps for good (earned or given), used for the profile page. */
export function earnedCosmetics(identifier: string): Set<string> {
    return earned(identifier);
}

/** Called whenever a logged-in player enters a room: notes the day and hands out the items of the running season. */
export function recordVisit(identifier: string): void {
    const day = today();
    st.visit.run(identifier, day);
    for (const item of cosmetics) {
        if (item.unlock.season && inSeason(item.unlock.season, day)) st.grant.run(identifier, item.id, "season");
    }
}

export function grantCosmetic(identifier: string, itemId: string, source = "manual"): void {
    st.grant.run(identifier, itemId, source);
}

export function revokeCosmetic(identifier: string, itemId: string): void {
    st.revoke.run(identifier, itemId);
}

export function cosmeticOwners(itemId: string): { identifier: string; source: string; createdAt: string }[] {
    return (st.owners.all(itemId) as { identifier: string; source: string; created_at: string }[]).map((r) => ({
        identifier: r.identifier,
        source: r.source,
        createdAt: r.created_at,
    }));
}

export type HolderReason = "everyone" | "role" | "season" | "manual";

/**
 * Who has an item right now and why: everyone it applies to automatically (everyone, roles incl. admins,
 * running season) plus those it was given to or who kept it from an earlier season.
 */
export function cosmeticHolders(item: Cosmetic, members: CosmeticViewer[]): { identifier: string; reason: HolderReason; stored: boolean; since?: string }[] {
    const stored = new Map(cosmeticOwners(item.id).map((o) => [o.identifier.toLowerCase(), o]));
    const out: { identifier: string; reason: HolderReason; stored: boolean; since?: string }[] = [];
    for (const m of members) {
        const own = stored.get(m.identifier.toLowerCase());
        const u = item.unlock;
        let reason: HolderReason | undefined;
        if (u.everyone) reason = "everyone";
        else if (isAdminViewer(m) || u.tags?.some((t) => m.tags.includes(t))) reason = "role";
        else if (own) reason = own.source === "season" ? "season" : "manual";
        else if (u.season && inSeason(u.season)) reason = "season";
        if (reason) out.push({ identifier: m.identifier, reason, stored: !!own, since: own?.createdAt });
    }
    return out;
}

/** Players who entered a room on a day ("YYYY-MM-DD"). */
export function visitorsOn(day: string): string[] {
    return (st.visitorsOn.all(day) as { identifier: string }[]).map((r) => r.identifier);
}

/** Short form of the rule for the admin overview ("01.10.–07.11.", "Top 3 Arcade", "10 Tage online"). */
export function unlockShort(item: Cosmetic, lang: Lang): string {
    const u = item.unlock;
    const de = lang === "de";
    if (u.everyone) return de ? "Für alle" : "Everyone";
    if (u.season) {
        const fmt = (md: string) => (de ? `${md.slice(3)}.${md.slice(0, 2)}.` : `${md.slice(0, 2)}/${md.slice(3)}`);
        return `${fmt(u.season.from)}–${fmt(u.season.to)}`;
    }
    if (u.tags) return u.tags.map((t) => roleStyle(t, lang).label).join(", ");
    return de ? "Bestimmte Personen" : "Certain people";
}

/** How to get an item, for the profile page. */
export function unlockHint(item: Cosmetic, lang: Lang): string {
    const u = item.unlock;
    const de = lang === "de";
    if (u.everyone) return de ? "Für alle" : "For everyone";
    const roles = (u.tags ?? []).map((t) => roleStyle(t, lang).label).join(", ");
    if (u.tags) return de ? `Nur für ${roles}` : `Only for ${roles}`;
    if (u.season) {
        const fmt = (md: string) => (de ? `${md.slice(3)}.${md.slice(0, 2)}.` : `${md.slice(0, 2)}/${md.slice(3)}`);
        return de
            ? `Zwischen ${fmt(u.season.from)} und ${fmt(u.season.to)} online sein, dann bleibt es dir`
            : `Be online between ${fmt(u.season.from)} and ${fmt(u.season.to)} and keep it`;
    }
    return de ? "Bekommt nur, wem ein Admin es gibt" : "Only for people an admin gives it to";
}
