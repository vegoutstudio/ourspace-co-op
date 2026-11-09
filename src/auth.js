/* =========================================================
   OurSpace.Co-op 後台登入（只用 LINE）

   GET  /api/auth/line/start      前往 LINE 登入
   GET  /api/auth/line/callback   LINE 登入回來
   GET  /api/auth/me              目前登入者、可進入的單位
   POST /api/auth/join            輸入驗證碼（開站碼／單位管理員碼／工作人員碼）
   POST /api/auth/logout          登出

   身分
   - 系統管理員：users.is_sysadmin = 1（用開站碼 SETUP_CODE 取得）
   - 單位管理員／工作人員：memberships，只在單位合作期間內有效
========================================================= */

import {
  ok, fail, readJson, clean, taiwanNow, randomHex, sha256Hex,
  getCookie, cookie, redirect, writeLog
} from "./util.js";

const SESSION_COOKIE = "coop_session";
const STATE_COOKIE = "coop_line_state";
const SESSION_HOURS = 24;
const MAX_CODE_FAILS = 5;
const LOCK_MINUTES = 15;

/* 後台前端每個寫入請求都要帶這個標頭（防 CSRF） */
export const ADMIN_HEADER = "X-Coop-Admin";


export async function handleAuthApi(request, url, env) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/auth/line/start" && method === "GET") return lineStart(url, env);
  if (path === "/api/auth/line/callback" && method === "GET") return lineCallback(request, url, env);
  if (path === "/api/auth/me" && method === "GET") return getMe(request, env);

  if (method === "POST") {
    if (!isSafeWrite(request, url)) return fail("FORBIDDEN", 403);
    if (path === "/api/auth/join") return join(request, env);
    if (path === "/api/auth/logout") return logout(request, env);
  }

  return null;
}


/* 寫入請求：必須帶自訂標頭，且來源是本站 */
export function isSafeWrite(request, url) {
  if (request.headers.get(ADMIN_HEADER) !== "1") return false;
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}


/* =========================================================
   LINE 登入
========================================================= */

function callbackUrl(url) {
  return url.origin + "/api/auth/line/callback";
}

function lineStart(url, env) {
  if (!env.LINE_CHANNEL_ID || !env.LINE_CHANNEL_SECRET) {
    return redirect("/admin/#error=line-not-configured");
  }
  const state = randomHex(16);
  const authorize =
    "https://access.line.me/oauth2/v2.1/authorize?response_type=code" +
    "&client_id=" + encodeURIComponent(env.LINE_CHANNEL_ID) +
    "&redirect_uri=" + encodeURIComponent(callbackUrl(url)) +
    "&state=" + state +
    "&scope=" + encodeURIComponent("profile openid");
  return redirect(authorize, [cookie(STATE_COOKIE, state, 600, "/api/auth/line")]);
}

async function lineCallback(request, url, env) {
  const clearState = cookie(STATE_COOKIE, "", 0, "/api/auth/line");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = getCookie(request, STATE_COOKIE);

  if (!code || !state || !saved || state !== saved) {
    return redirect("/admin/#error=login", [clearState]);
  }

  try {
    const tokenResponse = await fetch("https://api.line.me/oauth2/v2.1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(url),
        client_id: env.LINE_CHANNEL_ID,
        client_secret: env.LINE_CHANNEL_SECRET
      })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.id_token) throw new Error("LINE token failed");

    const verifyResponse = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: token.id_token, client_id: env.LINE_CHANNEL_ID })
    });
    const profile = await verifyResponse.json();
    if (!verifyResponse.ok || !profile.sub) throw new Error("LINE verify failed");

    const name = clean(profile.name, 50) || "LINE 使用者";
    const picture = /^https:\/\//.test(profile.picture || "") ? profile.picture : null;

    let user = await env.DB.prepare("SELECT id, disabled FROM users WHERE line_sub = ?").bind(profile.sub).first();

    if (!user) {
      const created = await env.DB.prepare(
        "INSERT INTO users (line_sub, display_name, picture_url, last_login_at) VALUES (?, ?, ?, ?)"
      ).bind(profile.sub, name, picture, taiwanNow()).run();
      user = { id: created.meta.last_row_id, disabled: 0 };
    } else {
      if (user.disabled) return redirect("/admin/#error=disabled", [clearState]);
      await env.DB.prepare("UPDATE users SET display_name = ?, picture_url = ?, last_login_at = ? WHERE id = ?")
        .bind(name, picture, taiwanNow(), user.id).run();
    }

    const sessionToken = randomHex(32);
    await env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))"
    ).bind(await sha256Hex(sessionToken), user.id, "+" + SESSION_HOURS + " hours").run();

    return redirect("/admin/", [clearState, cookie(SESSION_COOKIE, sessionToken, SESSION_HOURS * 3600, "/")]);

  } catch (error) {
    console.error("LINE login failed:", error);
    return redirect("/admin/#error=login", [clearState]);
  }
}

async function logout(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  const headers = new Headers({ "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, "", 0, "/"));
  return new Response(JSON.stringify({ success: true }), { headers });
}


/* =========================================================
   登入狀態
========================================================= */

export async function getUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;

  const user = await env.DB.prepare(
    "SELECT u.id, u.display_name, u.picture_url, u.is_sysadmin, u.disabled " +
    "FROM sessions s INNER JOIN users u ON u.id = s.user_id " +
    "WHERE s.token_hash = ? AND s.expires_at > datetime('now')"
  ).bind(await sha256Hex(token)).first();

  if (!user || user.disabled) return null;
  return user;
}

/* 使用者在某單位的角色：sysadmin／admin／staff；沒有權限回傳 null */
export async function unitRole(env, user, unitId) {
  if (!user) return null;
  if (user.is_sysadmin) return "sysadmin";
  const now = taiwanNow();
  const row = await env.DB.prepare(
    "SELECT m.role FROM memberships m INNER JOIN units u ON u.id = m.unit_id " +
    "WHERE m.user_id = ? AND m.unit_id = ? AND u.start_at <= ? AND u.end_at > ?"
  ).bind(user.id, unitId, now, now).first();
  return row ? row.role : null;
}

export function isAdminRole(role) {
  return role === "sysadmin" || role === "admin";
}

async function getMe(request, env) {
  const user = await getUser(request, env);
  if (!user) return ok({ user: null, units: [] });

  const now = taiwanNow();
  let units;

  if (user.is_sysadmin) {
    units = await env.DB.prepare(
      "SELECT id, code, name, event_title, start_at, end_at, 'sysadmin' AS role FROM units ORDER BY id DESC"
    ).all();
  } else {
    units = await env.DB.prepare(
      "SELECT u.id, u.code, u.name, u.event_title, u.start_at, u.end_at, m.role FROM memberships m " +
      "INNER JOIN units u ON u.id = m.unit_id " +
      "WHERE m.user_id = ? AND u.start_at <= ? AND u.end_at > ? ORDER BY u.id DESC"
    ).bind(user.id, now, now).all();
  }

  return ok({
    user: {
      id: user.id,
      name: user.display_name,
      picture: user.picture_url,
      is_sysadmin: !!user.is_sysadmin
    },
    now,
    soon: taiwanNow(24 * 3600 * 1000),
    units: units.results || []
  });
}


/* =========================================================
   驗證碼
========================================================= */

async function join(request, env) {
  const user = await getUser(request, env);
  if (!user) return fail("NOT_LOGGED_IN", 401);

  const body = await readJson(request);
  const code = clean(body && body.code, 64).toUpperCase().replace(/\s+/g, "");
  if (!code) return fail("REQUIRED", 400);

  const row = await env.DB.prepare("SELECT code_fails, code_locked_until FROM users WHERE id = ?").bind(user.id).first();
  const now = taiwanNow();
  if (row && row.code_locked_until && row.code_locked_until > now) {
    return fail("CODE_LOCKED", 429, { until: row.code_locked_until });
  }

  /* 開站碼：成為系統管理員 */
  if (env.SETUP_CODE && await sha256Hex(code) === await sha256Hex(String(env.SETUP_CODE).toUpperCase().replace(/\s+/g, ""))) {
    await env.DB.prepare("UPDATE users SET is_sysadmin = 1, code_fails = 0, code_locked_until = NULL WHERE id = ?")
      .bind(user.id).run();
    await writeLog(env, user.id, null, "become_sysadmin", null);
    return ok({ role: "sysadmin" });
  }

  const unit = await env.DB.prepare(
    "SELECT id, name, admin_code, staff_code FROM units WHERE (admin_code = ? OR staff_code = ?) AND start_at <= ? AND end_at > ?"
  ).bind(code, code, now, now).first();

  if (!unit) {
    const fails = (row ? row.code_fails : 0) + 1;
    if (fails >= MAX_CODE_FAILS) {
      await env.DB.prepare("UPDATE users SET code_fails = 0, code_locked_until = ? WHERE id = ?")
        .bind(taiwanNow(LOCK_MINUTES * 60 * 1000), user.id).run();
      return fail("CODE_LOCKED", 429);
    }
    await env.DB.prepare("UPDATE users SET code_fails = ? WHERE id = ?").bind(fails, user.id).run();
    return fail("CODE_INVALID", 400, { remaining: MAX_CODE_FAILS - fails });
  }

  const role = unit.admin_code === code ? "admin" : "staff";

  /* 已經是管理員的人輸入工作人員碼，不會被降級 */
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO memberships (user_id, unit_id, role) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id, unit_id) DO UPDATE SET role = CASE WHEN memberships.role = 'admin' THEN 'admin' ELSE excluded.role END"
    ).bind(user.id, unit.id, role),
    env.DB.prepare("UPDATE users SET code_fails = 0, code_locked_until = NULL WHERE id = ?").bind(user.id)
  ]);

  await writeLog(env, user.id, unit.id, "join", { role });
  return ok({ role, unit_id: unit.id, unit_name: unit.name });
}
