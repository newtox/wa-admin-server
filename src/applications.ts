// Third-party applications WorkAdventure offers in the chat ("share an app") and in the map editor.
// The list is data/applications.json (or APPLICATIONS_FILE); texts can be { de, en }, and image paths starting
// with "/" are served by this server.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { Lang } from "./i18n.js";

export const APPS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "apps");
const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "applications.json");

type Text = string | { de?: string; en?: string };
interface AppEntry {
    name: string;
    description?: Text;
    image?: string;
    regexUrl?: string;
    targetUrl?: string;
    forceNewTab?: boolean;
    allowAPI?: boolean;
    policy?: string;
}

let cache: AppEntry[] | undefined;
function entries(): AppEntry[] {
    if (!cache) {
        try {
            cache = JSON.parse(fs.readFileSync(config.applicationsFile ?? DEFAULT_FILE, "utf8")) as AppEntry[];
        } catch (err) {
            console.warn("Could not read the application list:", err instanceof Error ? err.message : err);
            cache = [];
        }
    }
    return cache;
}

/** Applications in WorkAdventure's format, in the player's language. */
export function applicationsFor(lang: Lang) {
    const text = (t: Text | undefined) => (t === undefined || typeof t === "string" ? t : (t[lang] ?? t.de ?? t.en));
    return entries().map((app) => ({
        name: app.name,
        description: text(app.description),
        image: app.image?.startsWith("/") ? (config.publicUrl ? config.publicUrl + app.image : undefined) : app.image,
        regexUrl: app.regexUrl,
        targetUrl: app.targetUrl,
        enabled: true,
        default: true,
        forceNewTab: app.forceNewTab ?? false,
        allowAPI: app.allowAPI ?? false,
        ...(app.policy ? { policy: app.policy } : {}),
    }));
}
