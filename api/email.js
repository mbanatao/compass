const {
  json, originAllowed, establishSession, dbRequest
} = require("../lib/server");
const {
  providerConfig, providerReady, buildAuthorization, encryptRefreshToken,
  decryptRefreshToken, normalizeEmail
} = require("../lib/email-oauth");

function qs(values) { return new URLSearchParams(values).toString(); }
function isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function providerInfo(provider) {
  const p = providerConfig(provider);
  return {
    provider,
    configured: providerReady(provider),
    setupNeeded: provider === "google" ? ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] :
      ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"],
    scopes: p.scopes
  };
}
async function loadWorkspace(token, userId) {
  const [connections, signals] = await Promise.all([
    dbRequest(token, "goal_compass_email_connections?" + qs({
      select: "id,provider,account_email,display_name,granted_scopes,status,last_synced_at,last_error,created_at,updated_at",
      user_id: "eq." + userId, order: "provider.asc,account_email.asc", limit: "50"
    })),
    dbRequest(token, "goal_compass_email_signals?" + qs({
      select: "id,connection_id,goal_id,provider_message_id,subject,sender_email,sender_name,received_at,signal_type,confidence,evidence_reason,review_state,due_at,action_url",
      user_id: "eq." + userId, order: "received_at.desc", limit: "60"
    }))
  ]);
  return { connections: Array.isArray(connections) ? connections : [], signals: Array.isArray(signals) ? signals : [] };
}
function classifyMessage(subject, preview, fromEmail) {
  const value = (String(subject || "") + " " + String(preview || "")).toLowerCase();
  if (/(deadline|due (today|tomorrow|on|by)|must be (sent|received|submitted)|expires? (on|by|soon)|payment due|renewal date|appointment confirmation)/i.test(value)) {
    return { type: "deadline", confidence: 4, reason: "Contains explicit deadline, expiry, or due-date language." };
  }
  if (/(please (reply|respond|confirm|review|approve|send|provide)|need your (approval|response|confirmation|decision)|action required|response needed|awaiting your|can you (send|confirm|review|approve)|could you (send|confirm|review|approve)|urgent request)/i.test(value)) {
    return { type: "reply_needed", confidence: 4, reason: "Contains a direct request or approval/response language." };
  }
  if (/(following up|follow[- ]up|checking in|just a reminder|gentle reminder|circling back|any update on)/i.test(value)) {
    return { type: "follow_up", confidence: 3, reason: "Contains follow-up or reminder language." };
  }
  if (/(i will|i'll|we will|we'll|promised to|committed to|i can deliver|we can deliver|send you by|deliver by)/i.test(value)) {
    return { type: "commitment", confidence: 3, reason: "Contains a possible personal or business commitment." };
  }
  return { type: "informational", confidence: 1, reason: "No high-confidence action pattern detected; review before treating this as a commitment." };
}
function parseSender(value) {
  const s = String(value || "").trim();
  const match = s.match(/^(.*?)\s*<([^<>]+)>$/);
  if (match) return { name: match[1].replace(/^"|"$/g, "").trim() || null, email: normalizeEmail(match[2]) || null };
  const plain = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return { name: null, email: plain ? normalizeEmail(plain[0]) : null };
}
function explicitDueDate(subject, preview, receivedAt) {
  const value = String(subject || "") + " " + String(preview || "");
  const iso = value.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) {
    const date = new Date(iso[1] + "T23:59:00.000Z");
    if (!Number.isNaN(date.getTime()) && date.getTime() >= Date.now() - 86400000) return date.toISOString();
  }
  if (/\bby today\b|\bdue today\b/i.test(value)) {
    const date = new Date(); date.setUTCHours(23, 59, 0, 0); return date.toISOString();
  }
  if (/\bby tomorrow\b|\bdue tomorrow\b/i.test(value)) {
    const date = new Date(); date.setUTCDate(date.getUTCDate() + 1); date.setUTCHours(23, 59, 0, 0); return date.toISOString();
  }
  return null;
}
async function refreshProviderToken(provider, refreshToken) {
  const p = providerConfig(provider);
  if (!providerReady(provider)) throw Object.assign(new Error("Provider OAuth is not configured."), { status: 503 });
  const body = new URLSearchParams({
    client_id: p.clientId,
    client_secret: p.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });
  if (provider === "microsoft") body.set("scope", p.scopes.join(" "));
  const response = await fetch(p.tokenUrl, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(), redirect: "error"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw Object.assign(new Error("The provider could not refresh this connection."), { status: response.status === 400 || response.status === 401 ? 401 : 502 });
  return { accessToken: data.access_token, refreshToken: data.refresh_token || refreshToken, expiresIn: Number(data.expires_in) || 3600 };
}
async function fetchGoogleMessages(accessToken, accountEmail) {
  const headers = { Authorization: "Bearer " + accessToken, Accept: "application/json" };
  const listResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=" + encodeURIComponent("newer_than:14d in:inbox -category:promotions -category:social"), { headers, redirect: "error" });
  const list = await listResponse.json().catch(() => ({}));
  if (!listResponse.ok) throw Object.assign(new Error("Gmail could not be read. Reconnect the account if permissions changed."), { status: listResponse.status === 401 || listResponse.status === 403 ? 401 : 502 });
  const messages = (list.messages || []).slice(0, 25);
  return Promise.all(messages.map(async item => {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(item.id) + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date", { headers, redirect: "error" });
    const msg = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    const headerMap = {};
    for (const header of ((msg.payload && msg.payload.headers) || [])) headerMap[String(header.name || "").toLowerCase()] = header.value || "";
    let receivedAt = null; if (msg.internalDate && Number.isFinite(Number(msg.internalDate))) receivedAt = new Date(Number(msg.internalDate)).toISOString(); else if (headerMap.date) { const parsedDate = new Date(headerMap.date); if (!Number.isNaN(parsedDate.getTime())) receivedAt = parsedDate.toISOString(); }
    const subject = String(headerMap.subject || "(No subject)").slice(0, 300);
    const preview = String(msg.snippet || "").slice(0, 400);
    const sender = parseSender(headerMap.from);
    const classification = classifyMessage(subject, preview, sender.email);
    return {
      user_id: null, connection_id: null, provider_message_id: String(item.id),
      subject, sender_email: sender.email, sender_name: sender.name, received_at: receivedAt,
      signal_type: classification.type, confidence: classification.confidence,
      evidence_reason: classification.reason, due_at: explicitDueDate(subject, preview, receivedAt),
      action_url: "https://mail.google.com/mail/u/0/#all/" + encodeURIComponent(item.id)
    };
  }));
}
async function fetchMicrosoftMessages(accessToken) {
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const url = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=25&$select=id,subject,receivedDateTime,from,bodyPreview,webLink&$filter=" +
    encodeURIComponent("receivedDateTime ge " + since) + "&$orderby=receivedDateTime desc";
  const response = await fetch(url, { headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" }, redirect: "error" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error("Outlook could not be read. Reconnect the account if permissions changed."), { status: response.status === 401 || response.status === 403 ? 401 : 502 });
  return (data.value || []).slice(0, 25).map(item => {
    const addr = item.from && item.from.emailAddress || {};
    const senderEmail = normalizeEmail(addr.address) || null;
    const subject = String(item.subject || "(No subject)").slice(0, 300);
    const preview = String(item.bodyPreview || "").slice(0, 400);
    const classification = classifyMessage(subject, preview, senderEmail);
    return {
      user_id: null, connection_id: null, provider_message_id: String(item.id),
      subject, sender_email: senderEmail, sender_name: String(addr.name || "").slice(0, 200) || null,
      received_at: item.receivedDateTime || null, signal_type: classification.type,
      confidence: classification.confidence, evidence_reason: classification.reason,
      due_at: explicitDueDate(subject, preview, item.receivedDateTime),
      action_url: typeof item.webLink === "string" && item.webLink.startsWith("https://") ? item.webLink : null
    };
  });
}
async function syncConnection(token, userId, connectionId) {
  if (!isUuid(connectionId)) throw Object.assign(new Error("Email connection ID is invalid."), { status: 400 });
  const rows = await dbRequest(token, "goal_compass_email_connections?" + qs({
    select: "id,user_id,provider,account_email,token_ciphertext,status", id: "eq." + connectionId,
    user_id: "eq." + userId, limit: "1"
  }));
  const connection = Array.isArray(rows) ? rows[0] : null;
  if (!connection) throw Object.assign(new Error("Email connection not found."), { status: 404 });
  if (connection.status === "disconnected") throw Object.assign(new Error("This email account is disconnected."), { status: 409 });
  let tokenData;
  try {
    tokenData = await refreshProviderToken(connection.provider, decryptRefreshToken(connection.token_ciphertext));
  } catch (e) {
    if (e.status === 401) {
      await dbRequest(token, "goal_compass_email_connections?" + qs({ id: "eq." + connection.id, user_id: "eq." + userId }), {
        method: "PATCH", prefer: "return=minimal",
        body: { status: "needs_reauth", last_error: "Authorization expired or was revoked.", updated_at: new Date().toISOString() }
      });
    }
    throw e;
  }
  let signals = connection.provider === "google" ?
    await fetchGoogleMessages(tokenData.accessToken, connection.account_email) :
    await fetchMicrosoftMessages(tokenData.accessToken);
  signals = signals.filter(Boolean).map(s => ({ ...s, user_id: userId, connection_id: connection.id, updated_at: new Date().toISOString() }));
  if (signals.length) {
    await dbRequest(token, "goal_compass_email_signals?on_conflict=" + encodeURIComponent("connection_id,provider_message_id"), {
      method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: signals
    });
  }
  const now = new Date().toISOString();
  await dbRequest(token, "goal_compass_email_connections?" + qs({ id: "eq." + connection.id, user_id: "eq." + userId }), {
    method: "PATCH", prefer: "return=minimal",
    body: {
      token_ciphertext: encryptRefreshToken(tokenData.refreshToken),
      status: "connected", last_synced_at: now, last_error: null, updated_at: now
    }
  });
  const count = signals.length;
  return { connectionId: connection.id, accountEmail: connection.account_email, count, syncedAt: now };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Cookie");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
  if (req.method === "POST" && !originAllowed(req)) return json(res, 403, { error: "Request origin rejected." });
  try {
    const session = await establishSession(req, res);
    if (!session || !session.user || !session.user.id) return json(res, 401, { error: "Sign in to manage private email connections." });
    const userId = session.user.id;
    if (req.method === "GET") {
      if (req.query && req.query.action === "score-context") {
        const rows = await dbRequest(session.accessToken, "goal_compass_email_signals?" + qs({
          select: "id,goal_id,signal_type,confidence,review_state,due_at,received_at",
          user_id: "eq." + userId, review_state: "eq.confirmed", goal_id: "not.is.null",
          order: "due_at.asc.nullslast,received_at.desc", limit: "100"
        }));
        return json(res, 200, { signals: Array.isArray(rows) ? rows : [], syncedAt: new Date().toISOString() });
      }
      const workspace = await loadWorkspace(session.accessToken, userId);
      return json(res, 200, {
        user: { id: userId, email: session.user.email || null },
        providers: { google: providerInfo("google"), microsoft: providerInfo("microsoft") },
        ...workspace
      });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (body.action === "connect") {
      const provider = body.provider === "microsoft" ? "microsoft" : body.provider === "google" ? "google" : "";
      const email = normalizeEmail(body.email);
      if (!provider || !email) return json(res, 400, { error: "Choose a supported provider and valid email address." });
      const result = buildAuthorization(provider, email, userId);
      const old = res.getHeader("Set-Cookie");
      const cookies = Array.isArray(old) ? old : old ? [String(old)] : [];
      cookies.push("gc_email_oauth_state=" + encodeURIComponent(result.signedState) + "; HttpOnly; Secure; SameSite=Lax; Path=/api/email/callback; Max-Age=600");
      res.setHeader("Set-Cookie", cookies);
      return json(res, 200, { authorizationUrl: result.authorizationUrl });
    }
    if (body.action === "disconnect") {
      if (!isUuid(body.connectionId)) return json(res, 400, { error: "Email connection ID is invalid." });
      await dbRequest(session.accessToken, "goal_compass_email_connections?" + qs({ id: "eq." + body.connectionId, user_id: "eq." + userId }), {
        method: "DELETE", prefer: "return=minimal"
      });
      return json(res, 200, { ok: true });
    }
    if (body.action === "sync") {
      const result = await syncConnection(session.accessToken, userId, body.connectionId);
      return json(res, 200, result);
    }
    if (body.action === "review_signal") {
      if (!isUuid(body.signalId)) return json(res, 400, { error: "Email signal ID is invalid." });
      const state = ["needs_review", "confirmed", "dismissed", "completed"].includes(body.reviewState) ? body.reviewState : "";
      if (!state) return json(res, 400, { error: "Choose a valid review state." });
      const values = { review_state: state, updated_at: new Date().toISOString() };
      if (Object.prototype.hasOwnProperty.call(body, "goalId")) {
        if (body.goalId === null || body.goalId === "") values.goal_id = null;
        else if (isUuid(body.goalId)) {
          const ownGoal = await dbRequest(session.accessToken, "goal_compass_goals?" + qs({
            select: "id", id: "eq." + body.goalId, user_id: "eq." + userId, limit: "1"
          }));
          if (!Array.isArray(ownGoal) || !ownGoal.length) return json(res, 400, { error: "Choose a goal owned by this Compass account." });
          values.goal_id = body.goalId;
        } else return json(res, 400, { error: "Goal ID is invalid." });
      }
      if (body.dueAt === null) values.due_at = null;
      else if (typeof body.dueAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dueAt)) values.due_at = new Date(body.dueAt + "T23:59:00.000Z").toISOString();
      await dbRequest(session.accessToken, "goal_compass_email_signals?" + qs({ id: "eq." + body.signalId, user_id: "eq." + userId }), {
        method: "PATCH", prefer: "return=minimal", body: values
      });
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: "Unknown email workspace action." });
  } catch (e) {
    const status = Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 503;
    return json(res, status, { error: e.code === "EMAIL_OAUTH_NOT_CONFIGURED" ? e.message : e.message || "Email workspace service is temporarily unavailable." });
  }
};
