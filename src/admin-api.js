/* =========================================================
   OurSpace.Co-op 後台 API（/api/admin/*，需 LINE 登入）

   單位
     GET    /api/admin/units/:id                    單位資料（含驗證碼，依角色）
     POST   /api/admin/units                        新增單位（系統管理員）
     PUT    /api/admin/units/:id                    修改單位（系統管理員）
     POST   /api/admin/units/:id/codes              { kind: admin|staff, action: regenerate|disable }
   名單
     GET    /api/admin/units/:id/entries            報名名單（工作人員看不到姓名、手機）
     GET    /api/admin/units/:id/export             匯出 CSV（單位管理員以上）
     POST   /api/admin/entries/:id/status           { status: main|wait|cancelled, force }
     DELETE /api/admin/entries/:id                  刪除一筆
   成員
     GET    /api/admin/units/:id/members
     DELETE /api/admin/units/:id/members/:userId
   系統（系統管理員）
     GET    /api/admin/settings                     個資／肖像權說明
     PUT    /api/admin/settings
     POST   /api/admin/images                       上傳圖片 { data: base64 }
========================================================= */

import {
  ok, fail, readJson, clean, cleanLine, toInt, taiwanNow, cleanDateTime,
  randomCode, isUniqueError, imageUrl, writeLog, currentConsents
} from "./util.js";

import { getUser, unitRole, isAdminRole, isSafeWrite } from "./auth.js";
import { countEntries, regState } from "./public-api.js";

const MAX_IMAGE_BYTES = 1024 * 1024;


export async function handleAdminApi(request, url, env) {
  const user = await getUser(request, env);
  if (!user) return fail("NOT_LOGGED_IN", 401);

  const method = request.method;
  if (method !== "GET" && !isSafeWrite(request, url)) return fail("FORBIDDEN", 403);

  const parts = url.pathname.split("/").filter(Boolean).slice(2);

  /* ---------- 系統管理員 ---------- */
  if (parts[0] === "settings" && parts.length === 1) {
    if (!user.is_sysadmin) return fail("FORBIDDEN", 403);
    if (method === "GET") return getSettings(env);
    if (method === "PUT") return saveSettings(request, env, user);
  }

  if (parts[0] === "images" && parts.length === 1 && method === "POST") {
    if (!user.is_sysadmin) return fail("FORBIDDEN", 403);
    return uploadImage(request, env, user);
  }

  if (parts[0] === "units" && parts.length === 1 && method === "POST") {
    if (!user.is_sysadmin) return fail("FORBIDDEN", 403);
    return saveUnit(request, env, user, null);
  }

  /* ---------- 單位 ---------- */
  if (parts[0] === "units" && /^\d+$/.test(parts[1] || "")) {
    const unitId = Number(parts[1]);
    const role = await unitRole(env, user, unitId);
    if (!role) return fail("FORBIDDEN", 403);

    const sub = parts[2];

    if (!sub && method === "GET") return getUnit(env, unitId, role);
    if (!sub && method === "PUT") {
      if (role !== "sysadmin") return fail("FORBIDDEN", 403);
      return saveUnit(request, env, user, unitId);
    }
    if (sub === "codes" && method === "POST") return changeCode(request, env, user, unitId, role);
    if (sub === "entries" && method === "GET") return listEntries(env, unitId, role);
    if (sub === "export" && method === "GET") {
      if (!isAdminRole(role)) return fail("FORBIDDEN", 403);
      return exportEntries(env, user, unitId);
    }
    if (sub === "members" && !parts[3] && method === "GET") {
      if (!isAdminRole(role)) return fail("FORBIDDEN", 403);
      return listMembers(env, unitId);
    }
    if (sub === "members" && /^\d+$/.test(parts[3] || "") && method === "DELETE") {
      if (!isAdminRole(role)) return fail("FORBIDDEN", 403);
      return removeMember(env, user, unitId, Number(parts[3]));
    }
  }

  /* ---------- 單筆報名 ---------- */
  if (parts[0] === "entries" && /^\d+$/.test(parts[1] || "")) {
    const entry = await env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(Number(parts[1])).first();
    if (!entry) return fail("NOT_FOUND", 404);
    const role = await unitRole(env, user, entry.unit_id);
    if (!isAdminRole(role)) return fail("FORBIDDEN", 403);

    if (parts[2] === "status" && method === "POST") return setStatus(request, env, user, entry);
    if (!parts[2] && method === "DELETE") return deleteEntry(env, user, entry);
  }

  return null;
}


/* =========================================================
   單位
========================================================= */

async function getUnit(env, unitId, role) {
  const unit = await env.DB.prepare("SELECT * FROM units WHERE id = ?").bind(unitId).first();
  if (!unit) return fail("NOT_FOUND", 404);

  const counts = await countEntries(env, unitId);
  const data = Object.assign({}, unit, {
    role,
    logo_url: imageUrl(unit.logo_image_id),
    cover_url: imageUrl(unit.cover_image_id),
    counts,
    reg_state: regState(unit, counts, taiwanNow())
  });

  /* 管理員碼只有系統管理員看得到；工作人員碼給單位管理員以上 */
  if (role !== "sysadmin") delete data.admin_code;
  if (!isAdminRole(role)) delete data.staff_code;

  return ok(data);
}

const TEXT_FIELDS = { intro: 3000, rules: 3000, prizes: 3000, notes: 3000, contact: 1000 };

async function saveUnit(request, env, user, unitId) {
  const body = await readJson(request);
  if (!body) return fail("INVALID_JSON", 400);

  const errors = [];
  const data = {
    name: cleanLine(body.name, 60),
    event_title: cleanLine(body.event_title, 80),
    event_time: cleanLine(body.event_time, 80) || null,
    location: cleanLine(body.location, 120) || null,
    accent: /^#[0-9a-fA-F]{6}$/.test(body.accent || "") ? body.accent.toUpperCase() : "#0F6E6E",
    start_at: cleanDateTime(body.start_at),
    end_at: cleanDateTime(body.end_at),
    reg_open: body.reg_open ? 1 : 0,
    reg_deadline: body.reg_deadline ? cleanDateTime(body.reg_deadline) : null,
    capacity_main: toInt(body.capacity_main, 1, 2000, null),
    capacity_wait: toInt(body.capacity_wait, 0, 2000, null),
    max_per_submit: toInt(body.max_per_submit, 1, 10, null),
    logo_image_id: toInt(body.logo_image_id, 1, 1e9, null),
    cover_image_id: toInt(body.cover_image_id, 1, 1e9, null)
  };

  for (const key of Object.keys(TEXT_FIELDS)) data[key] = clean(body[key], TEXT_FIELDS[key]) || null;

  if (!data.name) errors.push("name");
  if (!data.event_title) errors.push("event_title");
  if (!data.start_at) errors.push("start_at");
  if (!data.end_at) errors.push("end_at");
  if (data.start_at && data.end_at && data.end_at <= data.start_at) errors.push("end_at");
  if (body.reg_deadline && !data.reg_deadline) errors.push("reg_deadline");
  if (data.capacity_main === null) errors.push("capacity_main");
  if (data.capacity_wait === null) errors.push("capacity_wait");
  if (data.max_per_submit === null) errors.push("max_per_submit");

  let code = null;
  if (!unitId) {
    code = clean(body.code, 20).toLowerCase();
    if (!/^[a-z0-9]{3,12}$/.test(code)) errors.push("code");
  }

  if (errors.length) return fail("INVALID_FIELDS", 400, { fields: errors });

  const columns = Object.keys(data);

  try {
    if (unitId) {
      await env.DB.prepare(
        "UPDATE units SET " + columns.map((c) => c + " = ?").join(", ") + ", updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(...columns.map((c) => data[c]), unitId).run();
      await writeLog(env, user.id, unitId, "unit_update", null);
      return ok({ id: unitId });
    }

    const adminCode = await uniqueCode(env);
    const staffCode = await uniqueCode(env, adminCode);
    const all = columns.concat(["code", "admin_code", "staff_code"]);
    const values = columns.map((c) => data[c]).concat([code, adminCode, staffCode]);

    const result = await env.DB.prepare(
      "INSERT INTO units (" + all.join(", ") + ") VALUES (" + all.map(() => "?").join(", ") + ")"
    ).bind(...values).run();

    const id = result.meta.last_row_id;
    await writeLog(env, user.id, id, "unit_create", { code });
    return ok({ id, code, admin_code: adminCode, staff_code: staffCode }, 201);

  } catch (error) {
    if (isUniqueError(error)) return fail("CODE_TAKEN", 409);
    throw error;
  }
}

async function uniqueCode(env, avoid) {
  for (let i = 0; i < 10; i++) {
    const code = randomCode(8);
    if (code === avoid) continue;
    const used = await env.DB.prepare("SELECT 1 FROM units WHERE admin_code = ? OR staff_code = ?").bind(code, code).first();
    if (!used) return code;
  }
  throw new Error("cannot generate code");
}

async function changeCode(request, env, user, unitId, role) {
  const body = await readJson(request);
  const kind = body && body.kind;
  const action = body && body.action;

  if (kind !== "admin" && kind !== "staff") return fail("INVALID_KIND", 400);
  if (action !== "regenerate" && action !== "disable") return fail("INVALID_ACTION", 400);
  if (kind === "admin" && role !== "sysadmin") return fail("FORBIDDEN", 403);
  if (kind === "staff" && !isAdminRole(role)) return fail("FORBIDDEN", 403);

  const column = kind === "admin" ? "admin_code" : "staff_code";
  const code = action === "regenerate" ? await uniqueCode(env) : null;

  await env.DB.prepare("UPDATE units SET " + column + " = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(code, unitId).run();
  await writeLog(env, user.id, unitId, "code_" + action, { kind });
  return ok({ kind, code });
}


/* =========================================================
   名單
========================================================= */

async function listEntries(env, unitId, role) {
  const rows = await env.DB.prepare(
    "SELECT e.id, e.name, e.nickname, e.phone, e.status, e.agreed_at, " +
    "datetime(e.created_at, '+8 hours') AS created_tw, " +
    "CASE WHEN e.status = 'wait' THEN (SELECT COUNT(*) FROM entries w WHERE w.unit_id = e.unit_id AND w.status = 'wait' AND w.id <= e.id) END AS wait_no " +
    "FROM entries e WHERE e.unit_id = ? ORDER BY e.id"
  ).bind(unitId).all();

  const showContact = isAdminRole(role);
  const list = (rows.results || []).map(function (row) {
    const item = {
      id: row.id,
      nickname: row.nickname,
      status: row.status,
      wait_no: row.wait_no,
      created_at: String(row.created_tw || "").slice(0, 16)
    };
    if (showContact) {
      item.name = row.name;
      item.phone = row.phone;
      item.agreed_at = row.agreed_at;
    }
    return item;
  });

  return ok({ show_contact: showContact, entries: list, counts: await countEntries(env, unitId) });
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? "\"" + text.replace(/"/g, "\"\"") + "\"" : text;
}

async function exportEntries(env, user, unitId) {
  const unit = await env.DB.prepare("SELECT code FROM units WHERE id = ?").bind(unitId).first();
  const rows = await env.DB.prepare(
    "SELECT e.id, e.name, e.nickname, e.phone, e.status, e.agreed_at, datetime(e.created_at, '+8 hours') AS created_tw, " +
    "CASE WHEN e.status = 'wait' THEN (SELECT COUNT(*) FROM entries w WHERE w.unit_id = e.unit_id AND w.status = 'wait' AND w.id <= e.id) END AS wait_no " +
    "FROM entries e WHERE e.unit_id = ? ORDER BY e.id"
  ).bind(unitId).all();

  const label = { main: "正取", wait: "備取", cancelled: "已取消" };
  const lines = [["編號", "狀態", "備取順位", "姓名", "參賽暱稱", "手機", "報名時間", "同意個資與肖像權時間"].join(",")];

  for (const row of rows.results || []) {
    lines.push([
      row.id,
      label[row.status] || row.status,
      row.wait_no || "",
      row.name || "",
      row.nickname,
      /* 用 ="..." 讓 Excel 保留開頭的 0 */
      row.phone ? "=\"" + row.phone + "\"" : "",
      String(row.created_tw || "").slice(0, 16),
      row.agreed_at
    ].map(csvCell).join(","));
  }

  await writeLog(env, user.id, unitId, "export", { rows: (rows.results || []).length });

  const fileName = "entries-" + (unit ? unit.code : unitId) + "-" + taiwanNow().slice(0, 10) + ".csv";
  return new Response("\uFEFF" + lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=UTF-8",
      "Content-Disposition": "attachment; filename=\"" + fileName + "\"",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function setStatus(request, env, user, entry) {
  const body = await readJson(request);
  const status = body && body.status;
  if (["main", "wait", "cancelled"].indexOf(status) === -1) return fail("INVALID_STATUS", 400);
  if (status === entry.status) return ok({ id: entry.id, status });

  if (status === "main" && !(body && body.force)) {
    const unit = await env.DB.prepare("SELECT capacity_main FROM units WHERE id = ?").bind(entry.unit_id).first();
    const counts = await countEntries(env, entry.unit_id);
    if (counts.main >= unit.capacity_main) return fail("MAIN_FULL", 409);
  }

  try {
    await env.DB.prepare("UPDATE entries SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(status, entry.id).run();
  } catch (error) {
    /* 取消後想恢復，但暱稱或手機已被別人用了 */
    if (isUniqueError(error)) return fail("ALREADY_REGISTERED", 409);
    throw error;
  }

  await writeLog(env, user.id, entry.unit_id, "entry_status", { entry: entry.id, from: entry.status, to: status });
  return ok({ id: entry.id, status });
}

async function deleteEntry(env, user, entry) {
  await env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(entry.id).run();
  await writeLog(env, user.id, entry.unit_id, "entry_delete", { entry: entry.id, nickname: entry.nickname });
  return ok({ id: entry.id });
}


/* =========================================================
   成員
========================================================= */

async function listMembers(env, unitId) {
  const rows = await env.DB.prepare(
    "SELECT u.id, u.display_name, u.picture_url, m.role, datetime(m.created_at, '+8 hours') AS joined_tw " +
    "FROM memberships m INNER JOIN users u ON u.id = m.user_id WHERE m.unit_id = ? " +
    "ORDER BY CASE m.role WHEN 'admin' THEN 0 ELSE 1 END, m.created_at"
  ).bind(unitId).all();

  return ok((rows.results || []).map((row) => ({
    id: row.id,
    name: row.display_name,
    picture: row.picture_url,
    role: row.role,
    joined_at: String(row.joined_tw || "").slice(0, 16)
  })));
}

async function removeMember(env, user, unitId, memberId) {
  await env.DB.prepare("DELETE FROM memberships WHERE unit_id = ? AND user_id = ?").bind(unitId, memberId).run();
  await writeLog(env, user.id, unitId, "member_remove", { member: memberId });
  return ok({ id: memberId });
}


/* =========================================================
   系統設定
========================================================= */

async function getSettings(env) {
  const consents = await currentConsents(env);
  return ok({
    privacy: consents.privacy ? consents.privacy.body : "",
    portrait: consents.portrait ? consents.portrait.body : ""
  });
}

async function saveSettings(request, env, user) {
  const body = await readJson(request);
  if (!body) return fail("INVALID_JSON", 400);

  const privacy = clean(body.privacy, 5000);
  const portrait = clean(body.portrait, 5000);
  if (!privacy || !portrait) return fail("REQUIRED", 400);

  const current = await currentConsents(env);
  const statements = [];

  /* 文字有變才新增一版；舊版保留，報名紀錄會對到當時的版本 */
  if (!current.privacy || current.privacy.body !== privacy) {
    statements.push(env.DB.prepare("INSERT INTO consent_texts (kind, body, created_by) VALUES ('privacy', ?, ?)").bind(privacy, user.id));
  }
  if (!current.portrait || current.portrait.body !== portrait) {
    statements.push(env.DB.prepare("INSERT INTO consent_texts (kind, body, created_by) VALUES ('portrait', ?, ?)").bind(portrait, user.id));
  }

  if (statements.length) {
    await env.DB.batch(statements);
    await writeLog(env, user.id, null, "consent_update", null);
  }
  return ok({ changed: statements.length });
}


/* =========================================================
   圖片：只收 PNG／JPG／WebP，檢查檔案內容，≤ 1MB
========================================================= */

function detectMime(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

async function uploadImage(request, env, user) {
  const body = await readJson(request);
  const data = String((body && body.data) || "");

  if (!data || data.length > 1500000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return fail("INVALID_IMAGE", 400);

  let binary;
  try {
    binary = atob(data);
  } catch (e) {
    return fail("INVALID_IMAGE", 400);
  }
  if (binary.length > MAX_IMAGE_BYTES) return fail("IMAGE_TOO_LARGE", 400);

  const head = new Uint8Array(Math.min(16, binary.length));
  for (let i = 0; i < head.length; i++) head[i] = binary.charCodeAt(i);

  const mime = detectMime(head);
  if (!mime) return fail("INVALID_IMAGE", 400);

  const result = await env.DB.prepare("INSERT INTO images (mime, data, size, created_by) VALUES (?, ?, ?, ?)")
    .bind(mime, data, binary.length, user.id).run();

  const id = result.meta.last_row_id;
  return ok({ id, url: imageUrl(id) }, 201);
}
