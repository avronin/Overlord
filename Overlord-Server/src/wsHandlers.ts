import geoip from "geoip-lite";
import { encodeMessage, decodeMessage, WireMessage } from "./protocol";
import { Buffer } from "node:buffer";
import { ClientInfo } from "./types";
import {
  consumeThumbnailRequest,
  getThumbnail,
  generateThumbnail,
  setLatestFrame,
} from "./thumbnails";
import { upsertClientRow } from "./db";
import { metrics } from "./metrics";

const MAX_PING_RTT_MS = 15_000;
const CLIENT_DB_SYNC_INTERVAL_MS = Number(process.env.OVERLORD_CLIENT_DB_SYNC_MS || 5000);
const lastClientDbSync = new Map<string, number>();
const pendingClientDbUpdates = new Map<
  string,
  Partial<ClientInfo> & {
    id: string;
    lastSeen?: number;
    online?: number;
  }
>();

function queueClientDbUpdate(
  partial: Partial<ClientInfo> & {
    id: string;
    lastSeen?: number;
    online?: number;
  },
): void {
  const existing = pendingClientDbUpdates.get(partial.id);
  if (!existing) {
    pendingClientDbUpdates.set(partial.id, { ...partial });
    return;
  }
  pendingClientDbUpdates.set(partial.id, {
    ...existing,
    ...partial,
    id: partial.id,
    lastSeen: partial.lastSeen ?? existing.lastSeen,
    online: partial.online ?? existing.online,
    pingMs: partial.pingMs ?? existing.pingMs,
  });
}

function flushQueuedClientDbUpdates(): void {
  if (pendingClientDbUpdates.size === 0) {
    return;
  }
  for (const update of pendingClientDbUpdates.values()) {
    upsertClientRow(update);
  }
  pendingClientDbUpdates.clear();
}

setInterval(flushQueuedClientDbUpdates, CLIENT_DB_SYNC_INTERVAL_MS);

function shouldSyncClientToDb(clientId: string, now: number): boolean {
  const last = lastClientDbSync.get(clientId) || 0;
  if (now - last < CLIENT_DB_SYNC_INTERVAL_MS) {
    return false;
  }
  lastClientDbSync.set(clientId, now);
  return true;
}

export function clearClientSyncState(clientId: string): void {
  lastClientDbSync.delete(clientId);
  pendingClientDbUpdates.delete(clientId);
}

export function handleHello(
  info: ClientInfo,
  payload: WireMessage,
  ws: any,
  ip?: string,
) {
  if (ip) {
    info.ip = ip;
  }
  info.hwid = (payload as any).hwid as string | undefined;
  info.host = payload.host;
  info.os = payload.os;
  info.arch = payload.arch;
  info.version = payload.version;
  info.user = payload.user;
  info.monitors = payload.monitors;
  info.monitorInfo = (payload as any).monitorInfo || info.monitorInfo;
  info.inMemory = !!(payload as any).inMemory;
  const geo = ip ? geoip.lookup(ip) : undefined;
  const countryRaw =
    geo?.country || (payload as any).country || info.country || "ZZ";
  const country = /^[A-Z]{2}$/i.test(countryRaw)
    ? countryRaw.toUpperCase()
    : "ZZ";
  info.country = country;
  info.lastSeen = Date.now();
  info.online = true;

  upsertClientRow({
    id: info.id,
    hwid: info.hwid,
    role: info.role,
    ip: info.ip,
    host: info.host,
    os: info.os,
    arch: info.arch,
    version: info.version,
    user: info.user,
    monitors: info.monitors,
    country: info.country,
    lastSeen: info.lastSeen,
    online: 1,
  });

  sendPingRequest(info, ws, "hello");

}

export function handlePing(info: ClientInfo, payload: WireMessage, ws: any) {
  //console.log(`[ping] from client=${info.id} ts=${payload.ts ?? ""}`);
  const now = Date.now();
  info.lastSeen = now;
  info.online = true;
  if (shouldSyncClientToDb(info.id, now)) {
    queueClientDbUpdate({
      id: info.id,
      lastSeen: info.lastSeen,
      online: 1,
    });
  }
  ws.send(encodeMessage({ type: "pong", ts: payload.ts || Date.now() }));
  sendPingRequest(info, ws, "client_ping");
}

export function sendPingRequest(info: ClientInfo, ws: any, reason: string) {
  const now = Date.now();
  if (
    info.lastPingNonce !== undefined &&
    info.lastPingSent &&
    now-info.lastPingSent < MAX_PING_RTT_MS
  ) {
    return;
  }
  const nonce = now + Math.floor(Math.random() * 1000);
  info.lastPingSent = now;
  info.lastPingNonce = nonce;
  //console.log(`[ping] send ping to client=${info.id} reason=${reason} nonce=${nonce}`);
  ws.send(encodeMessage({ type: "ping", ts: nonce }));
}

export function handlePong(info: ClientInfo, payload: WireMessage) {
  const tsRaw = (payload as any).ts;
  const ts = typeof tsRaw === "number" ? tsRaw : Number(tsRaw);
  if (!Number.isFinite(ts)) {
    return;
  }

  const now = Date.now();
  const maxRttMs = MAX_PING_RTT_MS;
  const expectedNonce = info.lastPingNonce;
  if (expectedNonce === undefined) {
    return;
  }
  if (ts !== expectedNonce) {
    return;
  }
  if (!info.lastPingSent) {
    return;
  }

  const rtt = now - info.lastPingSent;
  const nowTs = Date.now();

  info.lastSeen = nowTs;
  info.online = true;
  info.lastPingNonce = undefined;

  if (rtt >= 0 && rtt < maxRttMs) {
    info.pingMs = rtt;
    queueClientDbUpdate({
      id: info.id,
      pingMs: info.pingMs,
      lastSeen: info.lastSeen,
      online: 1,
    });
    lastClientDbSync.set(info.id, nowTs);

    metrics.recordPing(rtt);
  } else {
    if (shouldSyncClientToDb(info.id, nowTs)) {
      queueClientDbUpdate({
        id: info.id,
        lastSeen: info.lastSeen,
        online: 1,
      });
    }
  }
}

export function handleFrame(info: ClientInfo, payload: any) {
  const bytes = payload.data as unknown as Uint8Array;
  const header = (payload as any).header;
  const allowedFormats = ["jpeg", "jpg", "webp"];
  const fmt = String(header?.format || "").toLowerCase();
  const safeFormat = allowedFormats.includes(fmt) ? fmt : "";

  metrics.recordBytesReceived(bytes.length);

  let sentToViewers = false;
  try {
    const globalAny: any = globalThis as any;
    if (header?.webcam) {
      if (globalAny.__webcamBroadcast) {
        sentToViewers = globalAny.__webcamBroadcast(info.id, bytes, header);
      }
      if (sentToViewers) {
        return;
      }
    } else if (header?.hvnc) {
      if (globalAny.__hvncBroadcast) {
        sentToViewers = globalAny.__hvncBroadcast(info.id, bytes, header);
      }
      if (sentToViewers) {
        return;
      }
    } else if (globalAny.__rdBroadcast) {
      sentToViewers = globalAny.__rdBroadcast(info.id, bytes, header);
      if (sentToViewers) {
        return;
      }
    }
  } catch {}

  if (safeFormat) {
    const now = Date.now();
    const thumbnailRequested = consumeThumbnailRequest(info.id);
    const hasThumbnail = Boolean(getThumbnail(info.id));
    if (thumbnailRequested || !hasThumbnail) {
      setLatestFrame(info.id, bytes, safeFormat);
      void generateThumbnail(info.id);
    }
    info.lastSeen = now;
    info.online = true;
    if (shouldSyncClientToDb(info.id, now)) {
      queueClientDbUpdate({ id: info.id, lastSeen: now, online: 1 });
    }
  }
}
