// When members were really last online, read from the Matrix chat server (Synapse).
//
// WorkAdventure only tells the admin API when someone enters a room, never when they leave or are still there.
// While WorkAdventure is open, its chat keeps a connection to Synapse and asks it for news every few seconds;
// Synapse notes the time per user (about every two minutes). This module asks Synapse's admin API for that
// time every two minutes, as WorkAdventure's own Matrix admin user, and moves "last seen" forward when it is newer.
import { config } from "./config.js";
import { listUsers, users } from "./db.js";
import { matrixId } from "./api.js";

/** Somebody counts as online when Synapse saw them within this time. */
const ONLINE_MS = 5 * 60_000;

const lastActive = new Map<string, number>();
let token: string | undefined;
let warned = false;

export const matrixActivityEnabled = () => !!(config.matrixApiUrl && config.matrixAdminUser && config.matrixAdminPassword && config.matrixDomain);

/** Whether Synapse saw the member in the last few minutes. */
export function isOnline(identifier: string, now = Date.now()): boolean {
    const t = lastActive.get(identifier.toLowerCase());
    return t !== undefined && now - t < ONLINE_MS;
}

async function login(): Promise<string> {
    const res = await fetch(`${config.matrixApiUrl}/_matrix/client/v3/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            type: "m.login.password",
            identifier: { type: "m.id.user", user: config.matrixAdminUser },
            password: config.matrixAdminPassword,
            initial_device_display_name: "workadventure-admin-server",
        }),
    });
    if (!res.ok) throw new Error(`Matrix login failed: ${res.status}`);
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new Error("Matrix login gave no access token");
    return body.access_token;
}

/** Last time Synapse saw any connection of this Matrix user (ms), 0 if never; undefined if the user does not exist. */
async function whois(userId: string, retry = true): Promise<number | undefined> {
    token ??= await login();
    const res = await fetch(`${config.matrixApiUrl}/_synapse/admin/v1/whois/${encodeURIComponent(userId)}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && retry) {
        token = undefined;
        return whois(userId, false);
    }
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Matrix whois ${userId} failed: ${res.status}`);
    const body = (await res.json()) as { devices?: Record<string, { sessions?: { connections?: { last_seen?: number }[] }[] }> };
    let latest = 0;
    for (const device of Object.values(body.devices ?? {})) {
        for (const session of device.sessions ?? []) {
            for (const connection of session.connections ?? []) latest = Math.max(latest, connection.last_seen ?? 0);
        }
    }
    return latest;
}

/** One round over all members with a Matrix id. */
export async function pollMatrixActivity(): Promise<void> {
    if (!matrixActivityEnabled()) return;
    try {
        for (const user of listUsers()) {
            const id = matrixId(user);
            if (!id) continue;
            const seen = await whois(id);
            if (!seen) continue;
            lastActive.set(user.identifier.toLowerCase(), seen);
            if (seen > Date.parse(user.lastSeen) + 1000) users.setLastSeen(user.identifier, new Date(seen).toISOString().replace(/\.\d{3}Z$/, "Z"));
        }
        warned = false;
    } catch (err) {
        // Synapse down or the credentials wrong: keep what we have and say so once.
        if (!warned) console.warn(`could not read last activity from Matrix: ${err instanceof Error ? err.message : String(err)}`);
        warned = true;
    }
}

export function startMatrixActivity(): void {
    if (!matrixActivityEnabled()) return;
    const every = config.matrixActivitySeconds * 1000;
    setTimeout(() => void pollMatrixActivity(), 3000).unref();
    setInterval(() => void pollMatrixActivity(), every).unref();
    console.info(`reading last activity from Matrix every ${config.matrixActivitySeconds}s`);
}
