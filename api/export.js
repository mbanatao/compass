const { json, establishSession, dbRequest } = require("../lib/server");

function qs(values) {
  const present = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") present[key] = String(value);
  }
  return new URLSearchParams(present).toString();
}

async function fetchAllRows(accessToken, table, select, userId, order) {
  const rows = [];
  const pageSize = 500;
  const safetyLimit = 20000;
  let offset = 0;
  while (offset <= safetyLimit) {
    const query = qs({
      select,
      user_id: "eq." + userId,
      order,
      limit: offset === safetyLimit ? 1 : pageSize,
      offset
    });
    const page = await dbRequest(accessToken, table + "?" + query);
    if (!Array.isArray(page)) throw new Error("An export table returned an unexpected response.");
    if (offset === safetyLimit) {
      if (page.length) throw Object.assign(new Error("This export exceeds the safe one-request limit. Contact support for a larger archive."), { status: 413 });
      return rows;
    }
    rows.push(...page);
    if (page.length < pageSize) return rows;
    offset += page.length;
  }
  throw Object.assign(new Error("This export exceeds the safe one-request limit. Contact support for a larger archive."), { status: 413 });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Cookie");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
  try {
    const session = await establishSession(req, res);
    if (!session || !session.user || !session.user.id) {
      return json(res, 401, { error: "Sign in to export your private Compass data." });
    }
    const userId = session.user.id;
    const [goals, activity, settings, goalProjectLinks, emailConnections, emailSignals] = await Promise.all([
      fetchAllRows(session.accessToken, "goal_compass_goals", "id,user_id,name,direction_degrees,description,next_action,importance,urgency,impact,momentum,evidence_confidence,progress,status,target_date,created_at,updated_at", userId, "created_at.asc"),
      fetchAllRows(session.accessToken, "goal_compass_activity_events", "id,user_id,goal_id,event_type,note,minutes,provenance,source_ref,occurred_at,created_at", userId, "occurred_at.asc"),
      fetchAllRows(session.accessToken, "goal_compass_settings", "user_id,current_focus_goal_id,planning_horizon,override_goal_id,override_date,theme,updated_at", userId, "updated_at.desc"),
      fetchAllRows(session.accessToken, "goal_compass_goal_project_links", "id,user_id,goal_id,project_id,relevance,created_at", userId, "created_at.asc"),
      fetchAllRows(session.accessToken, "goal_compass_email_connections",
        "id,provider,account_email,display_name,granted_scopes,status,last_synced_at,last_error,created_at,updated_at",
        userId, "created_at.asc"),
      fetchAllRows(session.accessToken, "goal_compass_email_signals",
        "id,connection_id,goal_id,provider_message_id,subject,sender_email,sender_name,received_at,signal_type,confidence,evidence_reason,review_state,due_at,action_url,created_at,updated_at",
        userId, "received_at.asc")
    ]);
    return json(res, 200, {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      account: { id: userId, email: session.user.email || null },
      compass: { goals, activity, settings, goalProjectLinks },
      email: { connections: emailConnections, signals: emailSignals },
      privacyNote: "Provider refresh tokens, access tokens, Supabase API keys, and OAuth signing/encryption secrets are excluded."
    });
  } catch (e) {
    const status = Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 503;
    return json(res, status, { error: status === 413 ? e.message : "The data export could not be prepared. No partial export was downloaded." });
  }
};
