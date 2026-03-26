import { authenticateRequest } from "../../auth";
import { getConfig } from "../../config";
import {
  getPendingClients,
  getEnrollmentStats,
  setClientEnrollmentStatus,
  getClientEnrollmentStatus,
  getClientIp,
  banIp,
  unbanIp,
  isIpBanned,
  listBannedIps,
} from "../../db";
import { logAudit, AuditAction } from "../../auditLog";
import * as clientManager from "../../clientManager";
import { setOnlineState } from "../../db";

export async function handleEnrollmentRoutes(
  req: Request,
  url: URL,
): Promise<Response | null> {
  // GET /api/enrollment/pending
  if (req.method === "GET" && url.pathname === "/api/enrollment/pending") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "viewer") return new Response("Forbidden", { status: 403 });

    const clients = getPendingClients();
    return Response.json({ items: clients });
  }

  // GET /api/enrollment/stats
  if (req.method === "GET" && url.pathname === "/api/enrollment/stats") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });

    const stats = getEnrollmentStats();
    return Response.json(stats);
  }

  // GET /api/enrollment/settings
  if (req.method === "GET" && url.pathname === "/api/enrollment/settings") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });

    const config = getConfig();
    return Response.json({
      requireApproval: config.enrollment?.requireApproval ?? true,
    });
  }

  // POST /api/enrollment/:id/approve
  const approveMatch = url.pathname.match(/^\/api\/enrollment\/([^/]+)\/approve$/);
  if (req.method === "POST" && approveMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "viewer") return new Response("Forbidden", { status: 403 });

    const clientId = decodeURIComponent(approveMatch[1]);
    const current = getClientEnrollmentStatus(clientId);
    if (!current) return Response.json({ error: "Client not found" }, { status: 404 });

    setClientEnrollmentStatus(clientId, "approved", user.username);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_APPROVE,
      targetClientId: clientId,
      success: true,
      details: JSON.stringify({ enrollment: "approved" }),
    });

    return Response.json({ ok: true, status: "approved" });
  }

  // POST /api/enrollment/:id/deny
  const denyMatch = url.pathname.match(/^\/api\/enrollment\/([^/]+)\/deny$/);
  if (req.method === "POST" && denyMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "viewer") return new Response("Forbidden", { status: 403 });

    const clientId = decodeURIComponent(denyMatch[1]);
    const current = getClientEnrollmentStatus(clientId);
    if (!current) return Response.json({ error: "Client not found" }, { status: 404 });

    setClientEnrollmentStatus(clientId, "denied");

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_DENY,
      targetClientId: clientId,
      success: true,
      details: JSON.stringify({ enrollment: "denied" }),
    });

    return Response.json({ ok: true, status: "denied" });
  }

  // POST /api/enrollment/:id/reset
  const resetMatch = url.pathname.match(/^\/api\/enrollment\/([^/]+)\/reset$/);
  if (req.method === "POST" && resetMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "viewer") return new Response("Forbidden", { status: 403 });

    const clientId = decodeURIComponent(resetMatch[1]);
    const current = getClientEnrollmentStatus(clientId);
    if (!current) return Response.json({ error: "Client not found" }, { status: 404 });

    setClientEnrollmentStatus(clientId, "pending");

    return Response.json({ ok: true, status: "pending" });
  }

  // POST /api/enrollment/bulk
  if (req.method === "POST" && url.pathname === "/api/enrollment/bulk") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "viewer") return new Response("Forbidden", { status: 403 });

    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const ids = Array.isArray(body?.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : [];
    const action = body?.action;

    if (!["approve", "deny", "reset", "ban-ip"].includes(action)) {
      return Response.json({ error: "action must be 'approve', 'deny', 'reset', or 'ban-ip'" }, { status: 400 });
    }
    if (ids.length === 0) {
      return Response.json({ error: "ids array is required" }, { status: 400 });
    }

    if (action === "ban-ip") {
      let banned = 0;
      for (const id of ids) {
        const clientIp = getClientIp(id);
        if (!clientIp) continue;
        banIp(clientIp, `Bulk banned from purgatory by ${user.username}`);
        setClientEnrollmentStatus(id, "denied");
        const target = clientManager.getClient(id);
        if (target) {
          try { target.ws.close(4003, "banned"); } catch {}
          setOnlineState(id, false);
        }
        banned++;
      }

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: "server",
        action: AuditAction.ENROLLMENT_BULK,
        success: true,
        details: JSON.stringify({ enrollment: { bulk: "ban-ip", count: banned } }),
      });

      return Response.json({ ok: true, action, updated: banned });
    }

    const status = action === "approve" ? "approved" : action === "deny" ? "denied" : "pending";
    let updated = 0;
    for (const id of ids) {
      const ok = setClientEnrollmentStatus(
        id,
        status as "approved" | "denied" | "pending",
        action === "approve" ? user.username : undefined,
      );
      if (ok) updated++;
    }

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_BULK,
      success: true,
      details: JSON.stringify({ enrollment: { bulk: action, count: updated } }),
    });

    return Response.json({ ok: true, action, updated });
  }

  // POST /api/enrollment/:id/ban-ip
  // Ban ip API makes me wanna fucking kms.
  const banMatch = url.pathname.match(/^\/api\/enrollment\/([^/]+)\/ban-ip$/);
  if (req.method === "POST" && banMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "viewer") return new Response("Forbidden", { status: 403 });

    const clientId = decodeURIComponent(banMatch[1]);
    const targetIp = getClientIp(clientId);
    if (!targetIp) return Response.json({ error: "Client IP not found" }, { status: 404 });

    banIp(targetIp, `Banned from purgatory by ${user.username} for client ${clientId}`);
    setClientEnrollmentStatus(clientId, "denied");

    const target = clientManager.getClient(clientId);
    if (target) {
      try { target.ws.close(4003, "banned"); } catch {}
      setOnlineState(clientId, false);
    }

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_DENY,
      targetClientId: clientId,
      success: true,
      details: JSON.stringify({ bannedIp: targetIp }),
    });

    return Response.json({ ok: true, ip: targetIp });
  }

  // GET /api/enrollment/banned-ips
  if (req.method === "GET" && url.pathname === "/api/enrollment/banned-ips") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "viewer") return new Response("Forbidden", { status: 403 });

    return Response.json({ items: listBannedIps() });
  }

  // DELETE /api/enrollment/banned-ips?ip=...
  if (req.method === "DELETE" && url.pathname === "/api/enrollment/banned-ips") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "viewer") return new Response("Forbidden", { status: 403 });

    const ipToUnban = (url.searchParams.get("ip") || "").trim();
    if (!ipToUnban) return Response.json({ error: "Missing ip parameter" }, { status: 400 });
    if (!/^[0-9a-fA-F:.]{3,64}$/.test(ipToUnban)) return Response.json({ error: "Invalid IP format" }, { status: 400 });
    if (!isIpBanned(ipToUnban)) return Response.json({ error: "IP is not banned" }, { status: 404 });

    unbanIp(ipToUnban);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_BULK,
      success: true,
      details: JSON.stringify({ unbannedIp: ipToUnban }),
    });

    return Response.json({ ok: true });
  }

  // POST /api/enrollment/ban-ip (manual IP ban)
  if (req.method === "POST" && url.pathname === "/api/enrollment/ban-ip") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "viewer") return new Response("Forbidden", { status: 403 });

    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

    const ip = typeof body?.ip === "string" ? body.ip.trim() : "";
    if (!ip) return Response.json({ error: "ip is required" }, { status: 400 });
    if (!/^[0-9a-fA-F:.]{3,64}$/.test(ip)) return Response.json({ error: "Invalid IP format" }, { status: 400 });

    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 200) : `Banned from purgatory by ${user.username}`;
    banIp(ip, reason);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_DENY,
      success: true,
      details: JSON.stringify({ bannedIp: ip, reason }),
    });

    return Response.json({ ok: true, ip });
  }

  return null;
}
