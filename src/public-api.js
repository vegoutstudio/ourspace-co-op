/* =========================================================
   OurSpace.Co-op 前台 API（免登入）

   GET  /api/public/units/:code            單位頁（活動介紹、報名狀況、個資說明）
   POST /api/public/units/:code/register   報名（一次多人）
   GET  /api/images/:id                    圖片
========================================================= */

import {
  ok, fail, readJson, cleanLine, taiwanNow, randomHex,
  isUniqueError, imageUrl, maskName, maskPhone, maskEmail, displayName,
  waitCapacity, currentConsents, DEFAULT_HOST_NAME, DEFAULT_FOOTER_TEXT
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
  return mainLeft(unit, counts) + Math.max(0, waitCapacity(unit) - counts.wait);
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

function hostInfo(unit) {
  return { show: !!unit.host_show, label: unit.host_label || "協辦", name: unit.host_name || DEFAULT_HOST_NAME };
}

function footerInfo(unit) {
  return { show: !!unit.footer_show, text: unit.footer_text || DEFAULT_FOOTER_TEXT };
}

/* 前台不回傳任何人數與名額設定 */
async function getUnit(env, code) {
  const unit = await env.DB.prepare("SELECT * FROM units WHERE code = ?").bind(code).first();
  const now = taiwanNow();

  if (!unit || unit.start_at > now) return fail("UNIT_NOT_FOUND", 404);

  if (unit.end_at <= now) {
    return ok({ state: "ended", name: unit.name, event_title: unit.event_title, accent: unit.accent, footer: footerInfo(unit) });
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
    host: hostInfo(unit),
    footer: footerInfo(unit),
    reg_deadline: unit.reg_deadline,
    max_per_submit: unit.max_per_submit,
    has_wait: unit.capacity_wait !== 0,
    main_full: mainLeft(unit, counts) <= 0,
    fields: {
      nickname: !!unit.nickname_required,
      phone: !!unit.phone_required,
      email: !!unit.email_required
    },
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const seen = { nickname: {}, phone: {}, email: {} };

  function checkDuplicate(index, field, value) {
    const key = value.toLowerCase();
    if (seen[field][key]) errors.push({ index, field, error: "DUPLICATE_IN_FORM" });
    seen[field][key] = true;
  }

  raw.forEach(function (item, index) {
    const person = {
      name: cleanLine(item && item.name, 60),
      nickname: cleanLine(item && item.nickname, 60),
      phone: cleanPhone(item && item.phone),
      email: cleanLine(item && item.email, 200).toLowerCase()
    };

    if (!person.name) errors.push({ index, field: "name", error: "REQUIRED" });
    else if (Array.from(person.name).length > 30) errors.push({ index, field: "name", error: "TOO_LONG" });

    if (!person.nickname) {
      if (unit.nickname_required) errors.push({ index, field: "nickname", error: "REQUIRED" });
    } else if (Array.from(person.nickname).length > 20) {
      errors.push({ index, field: "nickname", error: "TOO_LONG" });
    } else {
      checkDuplicate(index, "nickname", person.nickname);
    }

    if (!person.phone) {
      if (unit.phone_required) errors.push({ index, field: "phone", error: "REQUIRED" });
    } else if (!/^09\d{8}$/.test(person.phone)) {
      errors.push({ index, field: "phone", error: "INVALID_PHONE" });
    } else {
      checkDuplicate(index, "phone", person.phone);
    }

    if (!person.email) {
      if (unit.email_required) errors.push({ index, field: "email", error: "REQUIRED" });
    } else if (person.email.length > 100) {
      errors.push({ index, field: "email", error: "TOO_LONG" });
    } else if (!EMAIL_PATTERN.test(person.email)) {
      errors.push({ index, field: "email", error: "INVALID_EMAIL" });
    } else {
      checkDuplicate(index, "email", person.email);
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

  /* ---------- Turnstile ---------- */
  const human = await verifyTurnstile(env, body.turnstile, request.headers.get("CF-Connecting-IP"));
  if (!human) return fail("TURNSTILE_FAILED", 400);

  /* ---------- 和已報名的人比對（只比有填的欄位） ---------- */
  const lists = {
    nickname: people.map((p) => p.nickname).filter(Boolean),
    phone: people.map((p) => p.phone).filter(Boolean),
    email: people.map((p) => p.email).filter(Boolean)
  };
  const conditions = [];
  const binds = [unit.id];
  const marks = (list) => list.map(() => "?").join(",");

  if (lists.nickname.length) { conditions.push("nickname COLLATE NOCASE IN (" + marks(lists.nickname) + ")"); binds.push(...lists.nickname); }
  if (lists.phone.length) { conditions.push("phone IN (" + marks(lists.phone) + ")"); binds.push(...lists.phone); }
  if (lists.email.length) { conditions.push("email COLLATE NOCASE IN (" + marks(lists.email) + ")"); binds.push(...lists.email); }

  if (conditions.length) {
    const taken = await env.DB.prepare(
      "SELECT nickname, phone, email FROM entries WHERE unit_id = ? AND status <> 'cancelled' AND (" + conditions.join(" OR ") + ")"
    ).bind(...binds).all();

    const used = { nickname: {}, phone: {}, email: {} };
    for (const row of taken.results || []) {
      if (row.nickname) used.nickname[String(row.nickname).toLowerCase()] = true;
      if (row.phone) used.phone[row.phone] = true;
      if (row.email) used.email[String(row.email).toLowerCase()] = true;
    }

    people.forEach(function (person, index) {
      if (person.nickname && used.nickname[person.nickname.toLowerCase()]) errors.push({ index, field: "nickname", error: "NICKNAME_TAKEN" });
      if (person.phone && used.phone[person.phone]) errors.push({ index, field: "phone", error: "PHONE_TAKEN" });
      if (person.email && used.email[person.email]) errors.push({ index, field: "email", error: "EMAIL_TAKEN" });
    });

    if (errors.length) return fail("INVALID_PEOPLE", 400, { errors });
  }

  /* ---------- 寫入
     同一個交易內依表單順序決定正取／備取；名額滿了之後的人不寫入（收到滿為止）
     有人在備取時，新報名一律進備取（空出的正取由管理員手動遞補）
     備取名額 -1 = 無上限、0 = 不收備取 ---------- */
  const batch = randomHex(12);
  const agreedAt = taiwanNow();

  const statements = people.map(function (person) {
    return env.DB.prepare(
      "INSERT INTO entries (unit_id, batch, name, nickname, phone, email, status, privacy_text_id, portrait_text_id, agreed_at) " +
      "SELECT ?1, ?2, ?3, ?4, ?5, ?6, s.st, ?9, ?10, ?11 FROM (SELECT " +
      "CASE WHEN (SELECT COUNT(*) FROM entries WHERE unit_id = ?1 AND status = 'main') < ?7 " +
      "AND (SELECT COUNT(*) FROM entries WHERE unit_id = ?1 AND status = 'wait') = 0 THEN 'main' " +
      "WHEN ?8 < 0 OR (SELECT COUNT(*) FROM entries WHERE unit_id = ?1 AND status = 'wait') < ?8 THEN 'wait' " +
      "ELSE NULL END AS st) s WHERE s.st IS NOT NULL"
    ).bind(unit.id, batch, person.name, person.nickname, person.phone || null, person.email || null,
      unit.capacity_main, unit.capacity_wait, consents.privacy.id, consents.portrait.id, agreedAt);
  });

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (isUniqueError(error)) return fail("ALREADY_REGISTERED", 409);
    throw error;
  }

  const saved = await env.DB.prepare(
    "SELECT e.id, e.status, " +
    "CASE WHEN e.status = 'wait' THEN (SELECT COUNT(*) FROM entries w WHERE w.unit_id = e.unit_id AND w.status = 'wait' AND w.id <= e.id) END AS wait_no " +
    "FROM entries e WHERE e.batch = ? ORDER BY e.id"
  ).bind(batch).all();

  const rows = saved.results || [];
  if (!rows.length) return fail("REG_FULL", 409);

  /* 名額一旦滿了，後面的人都進不去，所以寫入的一定是表單前面的人 */
  return ok({
    event_title: unit.event_title,
    event_time: unit.event_time,
    people: people.map(function (person, index) {
      const row = rows[index];
      return {
        title: displayName(person.nickname, person.name),
        name_masked: maskName(person.name),
        phone_masked: maskPhone(person.phone),
        email_masked: maskEmail(person.email),
        status: row ? row.status : "rejected",
        wait_no: row ? row.wait_no : null
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
