/* =========================================================
   OurSpace.Co-op 前台 API（免登入）

   GET  /api/public/units/:code            單位頁（活動介紹、報名狀況、個資說明）
   POST /api/public/units/:code/register   報名（一次多人）
   GET  /api/images/:id                    圖片
========================================================= */

import {
  ok, fail, readJson, clean, cleanLine, taiwanNow, randomHex,
  isUniqueError, imageUrl, maskName, maskPhone, currentConsents
} from "./util.js";

const CODE_PATTERN = /^[a-z0-9]{3,12}$/;


export async function handlePublicApi(request, url, env) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[1] === "images" && parts.length === 3 && request.method === "GET") {
    return serveImage(env, parts[2]);
  }

  if (parts[1] === "public" && parts[2] === "units" && parts[3]) {
    const code = String(parts[3]).toLowerCase();
    if (!CODE_PATTERN.test(code)) return fail("UNIT_NOT_FOUND", 404);

    if (parts.length === 4 && request.method === "GET") return getUnit(env, code);
    if (parts.length === 5 && parts[4] === "register" && request.method === "POST") return register(request, env, code);
  }

  return null;
}


/* =========================================================
   單位狀態
========================================================= */

/* 正取還能直接報名的名額：只要有人在備取，空出來的正取留給管理員手動遞補 */
export function mainLeft(unit, counts) {
  return counts.wait > 0 ? 0 : Math.max(0, unit.capacity_main - counts.main);
}

export function roomLeft(unit, counts) {
  return mainLeft(unit, counts) + Math.max(0, unit.capacity_wait - counts.wait);
}

/* 報名狀態：open／closed（手動關閉）／deadline／full */
export function regState(unit, counts, now) {
  if (!unit.reg_open) return "closed";
  if (unit.reg_deadline && unit.reg_deadline <= now) return "deadline";
  if (roomLeft(unit, counts) <= 0) return "full";
  return "open";
}

export async function countEntries(env, unitId) {
  const row = await env.DB.prepare(
    "SELECT SUM(CASE WHEN status = 'main' THEN 1 ELSE 0 END) AS main, " +
    "SUM(CASE WHEN status = 'wait' THEN 1 ELSE 0 END) AS wait FROM entries WHERE unit_id = ?"
  ).bind(unitId).first();
  return { main: (row && row.main) || 0, wait: (row && row.wait) || 0 };
}

function fillUnitName(text, unitName) {
  return String(text || "").split("{單位}").join(unitName);
}

async function getUnit(env, code) {
  const unit = await env.DB.prepare("SELECT * FROM units WHERE code = ?").bind(code).first();
  const now = taiwanNow();

  if (!unit || unit.start_at > now) return fail("UNIT_NOT_FOUND", 404);

  if (unit.end_at <= now) {
    return ok({ state: "ended", name: unit.name, event_title: unit.event_title, accent: unit.accent });
  }

  const counts = await countEntries(env, unit.id);
  const consents = await currentConsents(env);

  return ok({
    state: "active",
    code: unit.code,
    name: unit.name,
    event_title: unit.event_title,
    event_time: unit.event_time,
    location: unit.location,
    intro: unit.intro,
    rules: unit.rules,
    prizes: unit.prizes,
    notes: unit.notes,
    contact: unit.contact,
    accent: unit.accent,
    logo_url: imageUrl(unit.logo_image_id),
    cover_url: imageUrl(unit.cover_image_id),
    reg_deadline: unit.reg_deadline,
    capacity_main: unit.capacity_main,
    capacity_wait: unit.capacity_wait,
    max_per_submit: unit.max_per_submit,
    counts,
    main_left: mainLeft(unit, counts),
    wait_left: Math.max(0, unit.capacity_wait - counts.wait),
    reg_state: regState(unit, counts, now),
    turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
    consents: {
      privacy: consents.privacy ? { id: consents.privacy.id, body: fillUnitName(consents.privacy.body, unit.name) } : null,
      portrait: consents.portrait ? { id: consents.portrait.id, body: fillUnitName(consents.portrait.body, unit.name) } : null
    }
  });
}


/* =========================================================
   報名
========================================================= */

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return false;
  if (!token || typeof token !== "string" || token.length > 2048) return false;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip || "" })
    });
    const result = await response.json();
    return !!(result && result.success);
  } catch (error) {
    console.error("turnstile failed:", error);
    return false;
  }
}

function cleanPhone(value) {
  return String(value || "").replace(/[\s\-()]/g, "");
}

async function register(request, env, code) {
  const body = await readJson(request);
  if (!body) return fail("INVALID_JSON", 400);

  const unit = await env.DB.prepare("SELECT * FROM units WHERE code = ?").bind(code).first();
  const now = taiwanNow();
  if (!unit || unit.start_at > now || unit.end_at <= now) return fail("UNIT_NOT_FOUND", 404);

  /* ---------- 報名者 ---------- */
  const raw = Array.isArray(body.people) ? body.people : [];
  if (!raw.length) return fail("REQUIRED", 400, { field: "people" });
  if (raw.length > unit.max_per_submit) return fail("TOO_MANY_PEOPLE", 400, { max: unit.max_per_submit });

  const people = [];
  const errors = [];
  const seenNick = {};
  const seenPhone = {};

  raw.forEach(function (item, index) {
    const person = {
      name: cleanLine(item && item.name, 60),
      nickname: cleanLine(item && item.nickname, 60),
      phone: cleanPhone(item && item.phone)
    };

    if (!person.name) errors.push({ index, field: "name", error: "REQUIRED" });
    else if (Array.from(person.name).length > 30) errors.push({ index, field: "name", error: "TOO_LONG" });

    if (!person.nickname) errors.push({ index, field: "nickname", error: "REQUIRED" });
    else if (Array.from(person.nickname).length > 20) errors.push({ index, field: "nickname", error: "TOO_LONG" });
    else {
      const key = person.nickname.toLowerCase();
      if (seenNick[key]) errors.push({ index, field: "nickname", error: "DUPLICATE_IN_FORM" });
      seenNick[key] = true;
    }

    if (!person.phone) errors.push({ index, field: "phone", error: "REQUIRED" });
    else if (!/^09\d{8}$/.test(person.phone)) errors.push({ index, field: "phone", error: "INVALID_PHONE" });
    else {
      if (seenPhone[person.phone]) errors.push({ index, field: "phone", error: "DUPLICATE_IN_FORM" });
      seenPhone[person.phone] = true;
    }

    people.push(person);
  });

  if (errors.length) return fail("INVALID_PEOPLE", 400, { errors });

  /* ---------- 同意 ---------- */
  const consents = await currentConsents(env);
  if (!consents.privacy || !consents.portrait) return fail("CONSENT_NOT_READY", 500);
  if (body.agree_privacy !== true || body.agree_portrait !== true) return fail("CONSENT_REQUIRED", 400);
  if (Number(body.privacy_id) !== consents.privacy.id || Number(body.portrait_id) !== consents.portrait.id) {
    return fail("CONSENT_CHANGED", 409);
  }

  /* ---------- 報名狀態 ---------- */
  const counts = await countEntries(env, unit.id);
  const state = regState(unit, counts, now);
  if (state !== "open") return fail("REG_" + state.toUpperCase(), 409);

  const room = roomLeft(unit, counts);
  if (people.length > room) return fail("NOT_ENOUGH_ROOM", 409, { room });

  /* ---------- Turnstile ---------- */
  const human = await verifyTurnstile(env, body.turnstile, request.headers.get("CF-Connecting-IP"));
  if (!human) return fail("TURNSTILE_FAILED", 400);

  /* ---------- 和已報名的人比對 ---------- */
  const nickList = people.map((p) => p.nickname);
  const phoneList = people.map((p) => p.phone);
  const marks = (list) => list.map(() => "?").join(",");

  const taken = await env.DB.prepare(
    "SELECT nickname, phone FROM entries WHERE unit_id = ? AND status <> 'cancelled' AND " +
    "(nickname COLLATE NOCASE IN (" + marks(nickList) + ") OR phone IN (" + marks(phoneList) + "))"
  ).bind(unit.id, ...nickList, ...phoneList).all();

  const takenNick = {};
  const takenPhone = {};
  for (const row of taken.results || []) {
    takenNick[String(row.nickname).toLowerCase()] = true;
    if (row.phone) takenPhone[row.phone] = true;
  }

  people.forEach(function (person, index) {
    if (takenNick[person.nickname.toLowerCase()]) errors.push({ index, field: "nickname", error: "NICKNAME_TAKEN" });
    if (takenPhone[person.phone]) errors.push({ index, field: "phone", error: "PHONE_TAKEN" });
  });

  if (errors.length) return fail("INVALID_PEOPLE", 400, { errors });

  /* ---------- 寫入：同一個交易內依序決定正取／備取；任何一筆失敗全部取消
     有人在備取時，新報名一律進備取（空出的正取由管理員手動遞補） ---------- */
  const batch = randomHex(12);
  const agreedAt = taiwanNow();

  const statements = people.map(function (person) {
    return env.DB.prepare(
      "INSERT INTO entries (unit_id, batch, name, nickname, phone, status, privacy_text_id, portrait_text_id, agreed_at) " +
      "SELECT ?1, ?2, ?3, ?4, ?5, " +
      "CASE WHEN (SELECT COUNT(*) FROM entries WHERE unit_id = ?1 AND status = 'main') < ?6 " +
      "AND (SELECT COUNT(*) FROM entries WHERE unit_id = ?1 AND status = 'wait') = 0 THEN 'main' " +
      "WHEN (SELECT COUNT(*) FROM entries WHERE unit_id = ?1 AND status = 'wait') < ?7 THEN 'wait' " +
      "ELSE NULL END, ?8, ?9, ?10"
    ).bind(unit.id, batch, person.name, person.nickname, person.phone,
      unit.capacity_main, unit.capacity_wait, consents.privacy.id, consents.portrait.id, agreedAt);
  });

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const message = String(error && error.message);
    if (isUniqueError(error)) return fail("ALREADY_REGISTERED", 409);
    if (message.indexOf("NOT NULL constraint failed") !== -1) return fail("REG_FULL", 409);
    throw error;
  }

  const saved = await env.DB.prepare(
    "SELECT e.id, e.name, e.nickname, e.phone, e.status, " +
    "CASE WHEN e.status = 'wait' THEN (SELECT COUNT(*) FROM entries w WHERE w.unit_id = e.unit_id AND w.status = 'wait' AND w.id <= e.id) END AS wait_no " +
    "FROM entries e WHERE e.batch = ? ORDER BY e.id"
  ).bind(batch).all();

  return ok({
    event_title: unit.event_title,
    event_time: unit.event_time,
    people: (saved.results || []).map(function (row) {
      return {
        nickname: row.nickname,
        name_masked: maskName(row.name),
        phone_masked: maskPhone(row.phone),
        status: row.status,
        wait_no: row.wait_no
      };
    })
  }, 201);
}


/* =========================================================
   圖片
========================================================= */

async function serveImage(env, id) {
  if (!/^\d{1,9}$/.test(id)) return fail("NOT_FOUND", 404);
  const row = await env.DB.prepare("SELECT mime, data FROM images WHERE id = ?").bind(Number(id)).first();
  if (!row) return fail("NOT_FOUND", 404);

  const binary = atob(row.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, {
    headers: {
      "Content-Type": row.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'"
    }
  });
}
