const { config, json, originAllowed, establishSession, dbRequest } = require("../lib/server");

function qs(values) { return new URLSearchParams(values).toString(); }
function isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function cleanText(value, max, fallback = "") { return typeof value === "string" ? value.trim().slice(0, max) : fallback; }
function clampInt(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback; }
function safeDate(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null; }
async function sourceRows(token, table, fields, extra = {}) {
  try {
    const query = qs({ select: fields, ...extra });
    const rows = await dbRequest(token, table + "?" + query);
    return { available: true, items: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    return { available: false, items: [], reason: e.status === 401 || e.status === 403 ? "not_visible_to_this_account" : "source_unavailable" };
  }
}
async function userRows(token, table, userId, fields, extra = {}) {
  const rows = await dbRequest(token, table + "?" + qs({ select: fields, user_id: "eq." + userId, ...extra }));
  return Array.isArray(rows) ? rows : [];
}
async function syncProjectLinks(token, userId, goalId, projectIds) {
  const ids = Array.isArray(projectIds) ? [...new Set(projectIds.filter(isUuid))].slice(0, 100) : [];
  await dbRequest(token, "goal_compass_goal_project_links?" + qs({ user_id: "eq." + userId, goal_id: "eq." + goalId }), { method: "DELETE", prefer: "return=minimal" });
  if (ids.length) {
    await dbRequest(token, "goal_compass_goal_project_links", {
      method: "POST",
      prefer: "return=minimal",
      body: ids.map(project_id => ({ user_id: userId, goal_id: goalId, project_id, relevance: 3 }))
    });
  }
}
function normalizeEventType(input) {
  const key = cleanText(input, 40).toLowerCase().replace(/\s+/g, "-");
  const allowed = new Set(["progress", "decision", "blocker", "insight", "check-in", "action-started", "priority-override", "goal-updated"]);
  return allowed.has(key) ? key : "check-in";
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Cookie");
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
  if (req.method === "POST" && !originAllowed(req)) return json(res, 403, { error: "Request origin rejected." });
  let session;
  try {
    config();
    session = await establishSession(req, res);
    if (!session || !session.user || !session.user.id) return json(res, 401, { error: "Sign in to access your private Goal Compass data." });
    const userId = session.user.id;
    if (req.method === "GET") {
      const [goals, events, settings, links, projects, tasks, decisions, lessons, externalEvents, experience] = await Promise.all([
        userRows(session.accessToken, "goal_compass_goals", userId, "*", { order: "created_at.asc", limit: "100" }),
        userRows(session.accessToken, "goal_compass_activity_events", userId, "*", { order: "occurred_at.desc", limit: "100" }),
        userRows(session.accessToken, "goal_compass_settings", userId, "*", { limit: "1" }),
        userRows(session.accessToken, "goal_compass_goal_project_links", userId, "id,goal_id,project_id,relevance,created_at", { order: "created_at.asc", limit: "300" }),
        sourceRows(session.accessToken, "projectos_projects", "id,name,objective,status,progress_percent,current_phase_key,current_task_key,repository,updated_at,last_reconciled_at", { order: "updated_at.desc", limit: "100" }),
        sourceRows(session.accessToken, "projectos_tasks", "id,project_id,task_key,title,description,priority,status,blocks_phase_exit,started_at,completed_at,updated_at", { order: "priority.desc", limit: "300" }),
        sourceRows(session.accessToken, "projectos_decisions", "id,project_id,decision_type,statement,rationale,confidence,source,created_at", { order: "created_at.desc", limit: "75" }),
        sourceRows(session.accessToken, "projectos_lessons", "id,project_id,category,lesson,evidence_count,confidence,status,promoted_at,updated_at", { status: "eq.promoted", order: "updated_at.desc", limit: "75" }),
        sourceRows(session.accessToken, "projectos_external_events", "project_id,provider,event_type,repository,external_created_at,process_status,received_at", { order: "received_at.desc", limit: "50" }),
        sourceRows(session.accessToken, "pandora_project_experience_projection", "project_id,experience_state,needs_you,can_focus,last_transition_at,updated_at", { order: "updated_at.desc", limit: "100" })
      ]);
      return json(res, 200, {
        user: { id: userId, email: session.user.email || null },
        goals, events, settings: settings[0] || null, links,
        sources: {
          syncedAt: new Date().toISOString(),
          projects, tasks, decisions, lessons, externalEvents, experience
        }
      });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const action = body.action;
    if (action === "save_goal") {
      const g = body.goal || {};
      if (!isUuid(g.id)) return json(res, 400, { error: "Goal ID is invalid." });
      const direction = Number(g.direction);
      if (![0, 90, 180, 270].includes(direction)) return json(res, 400, { error: "Choose a valid compass direction." });
      const name = cleanText(g.name, 60);
      const description = cleanText(g.description, 2000);
      const nextAction = cleanText(g.nextAction, 240);
      if (!name || !nextAction) return json(res, 400, { error: "Each goal needs a name and a next action." });
      const row = {
        id: g.id, user_id: userId, name, direction_degrees: direction, description, next_action: nextAction,
        importance: clampInt(g.importance, 1, 5, 3), urgency: clampInt(g.urgency, 1, 5, 3),
        impact: clampInt(g.impact, 1, 5, 3), momentum: clampInt(g.momentum, 1, 5, 3),
        evidence_confidence: clampInt(g.confidence, 1, 5, 3), progress: clampInt(g.progress, 0, 100, 0),
        status: ["active", "paused", "completed"].includes(g.status) ? g.status : "active",
        target_date: safeDate(g.deadline), updated_at: new Date().toISOString()
      };
      let saved;
      try {
        const rows = await dbRequest(session.accessToken, "goal_compass_goals?on_conflict=id", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: row });
        saved = Array.isArray(rows) ? rows[0] : null;
        if (!saved) return json(res, 500, { error: "Goal save returned no record." });
        if (Array.isArray(body.projectIds)) await syncProjectLinks(session.accessToken, userId, saved.id, body.projectIds);
      } catch (e) {
        if (e.code === "23505") return json(res, 409, { error: "Each compass direction can have only one goal. Move or rename the goal that already uses this direction." });
        if (e.status === 401 || e.status === 403) return json(res, 403, { error: "The save was blocked by account or row-level permissions." });
        return json(res, 400, { error: "Goal could not be saved. Check for a duplicate direction and valid values." });
      }
      return json(res, 200, { goal: saved });
    }
    if (action === "delete_goal") {
      if (!isUuid(body.goalId)) return json(res, 400, { error: "Goal ID is invalid." });
      await dbRequest(session.accessToken, "goal_compass_goals?" + qs({ id: "eq." + body.goalId, user_id: "eq." + userId }), { method: "DELETE", prefer: "return=minimal" });
      return json(res, 200, { ok: true });
    }
    if (action === "log_activity") {
      const note = cleanText(body.note, 1000);
      if (!note) return json(res, 400, { error: "Add a note before logging an event." });
      const goalId = isUuid(body.goalId) ? body.goalId : null;
      const minutes = body.minutes === null || body.minutes === "" || body.minutes === undefined ? null : clampInt(body.minutes, 0, 1440, 0);
      const row = { user_id: userId, goal_id: goalId, event_type: normalizeEventType(body.eventType), note, minutes, provenance: "user_entered", occurred_at: new Date().toISOString() };
      const rows = await dbRequest(session.accessToken, "goal_compass_activity_events", { method: "POST", prefer: "return=representation", body: row });
      return json(res, 200, { event: Array.isArray(rows) ? rows[0] : null });
    }
    if (action === "clear_activity") {
      await dbRequest(session.accessToken, "goal_compass_activity_events?" + qs({ user_id: "eq." + userId }), { method: "DELETE", prefer: "return=minimal" });
      return json(res, 200, { ok: true });
    }
    if (action === "save_settings") {
      const currentId = isUuid(body.currentFocusGoalId) ? body.currentFocusGoalId : null;
      const overrideId = isUuid(body.overrideGoalId) ? body.overrideGoalId : null;
      const horizon = ["today", "week", "northstar"].includes(body.planningHorizon) ? body.planningHorizon : "today";
      const theme = body.theme === "light" ? "light" : "dark";
      const row = { user_id: userId, current_focus_goal_id: currentId, planning_horizon: horizon, override_goal_id: overrideId, override_date: overrideId ? safeDate(body.overrideDate) : null, theme, updated_at: new Date().toISOString() };
      await dbRequest(session.accessToken, "goal_compass_settings?on_conflict=user_id", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: row });
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: "Unknown data action." });
  } catch (e) {
    if (e.status === 401) return json(res, 401, { error: "Your session expired. Sign in again." });
    return json(res, 503, { error: "Goal Compass data service is temporarily unavailable. Your browser-local demo remains available." });
  }
};
