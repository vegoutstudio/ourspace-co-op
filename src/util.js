/* =========================================================
   OurSpace.Co-op 共用工具
========================================================= */

export function jsonResponse(data, status, extraHeaders) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=UTF-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  });
  if (extraHeaders) {
    for (const [key, value] of extraHeaders) {
      headers.append(key, value);
    }
  }
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

export function ok(data, status) {
  return jsonResponse({ success: true, data: data === undefined ? null : data }, status || 200);
}

export function fail(error, status, extra) {
  return jsonResponse(Object.assign({ success: false, error }, extra || {}), status || 400);
}

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch (e) {
    return null;
  }
}

/* 去頭尾空白、移除控制字元 */
export function clean(value, maxLength) {
  if (value === undefined || value === null) return "";
  let text = String(value).replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();
  if (maxLength) text = text.slice(0, maxLength);
  return text;
}

/* 單行文字：連換行也拿掉 */
export function cleanLine(value, maxLength) {
  return clean(String(value === undefined || value === null ? "" : value).replace(/[\r\n]+/g, " "), maxLength);
}

export function toInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

/* 台灣時間 YYYY-MM-DD HH:MM（字串可以直接比大小） */
export function taiwanNow(offsetMs) {
  const date = new Date(Date.now() + 8 * 3600 * 1000 + (offsetMs || 0));
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/* 接受 YYYY-MM-DD HH:MM 或 YYYY-MM-DDTHH:MM，回傳空白分隔格式；不合法回傳 null */
export function cleanDateTime(value) {
  const text = clean(value).replace("T", " ").slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return null;
  const check = new Date(text.replace(" ", "T") + ":00Z");
  if (isNaN(check.getTime())) return null;
  return text;
}

export function randomHex(bytes) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/* 驗證碼：去掉 0 O 1 I L 這類容易看錯的字 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function randomCode(length) {
  let result = "";
  const array = new Uint8Array(1);
  while (result.length < length) {
    crypto.getRandomValues(array);
    /* 248 = 31 × 8，超過就丟掉，避免機率偏差 */
    if (array[0] < 248) result += CODE_ALPHABET[array[0] % CODE_ALPHABET.length];
  }
  return result;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

export function cookie(name, value, maxAge, path) {
  return name + "=" + value + "; Path=" + (path || "/") + "; Max-Age=" + maxAge +
    "; HttpOnly; Secure; SameSite=Lax";
}

export function redirect(location, cookies) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies || []) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

export function isUniqueError(error) {
  return String(error && error.message).indexOf("UNIQUE constraint failed") !== -1;
}

export function imageUrl(id) {
  return id ? "/api/images/" + id : null;
}

/* 姓名遮蔽：王小明 → 王○明，王明 → 王○ */
export function maskName(name) {
  const chars = Array.from(name || "");
  if (chars.length <= 1) return chars.join("");
  if (chars.length === 2) return chars[0] + "○";
  return chars[0] + "○".repeat(chars.length - 2) + chars[chars.length - 1];
}

export function maskPhone(phone) {
  const text = String(phone || "");
  return text.length === 10 ? text.slice(0, 2) + "****" + text.slice(6) : "";
}

export async function writeLog(env, userId, unitId, action, detail) {
  try {
    await env.DB.prepare("INSERT INTO audit_logs (user_id, unit_id, action, detail) VALUES (?, ?, ?, ?)")
      .bind(userId || null, unitId || null, action, detail ? JSON.stringify(detail) : null)
      .run();
  } catch (error) {
    console.error("audit log failed:", error);
  }
}

/* 目前的個資／肖像權說明文字（各取最新一版） */
export async function currentConsents(env) {
  const rows = await env.DB.prepare(
    "SELECT c.id, c.kind, c.body FROM consent_texts c " +
    "WHERE c.id = (SELECT MAX(id) FROM consent_texts WHERE kind = c.kind)"
  ).all();
  const result = {};
  for (const row of rows.results || []) result[row.kind] = { id: row.id, body: row.body };
  return result;
}

/* Email 遮蔽：abcdef@gmail.com → ab***@gmail.com */
export function maskEmail(email) {
  const text = String(email || "");
  const at = text.indexOf("@");
  if (at < 1) return "";
  return text.slice(0, Math.min(2, at)) + "***" + text.slice(at);
}

/* 對外顯示名稱：有暱稱用暱稱，沒有就用遮蔽姓名 */
export function displayName(nickname, name) {
  return nickname ? nickname : (maskName(name) || "（未填）");
}

/* 備取名額：-1 代表無上限 */
export function waitCapacity(unit) {
  return unit.capacity_wait < 0 ? Infinity : unit.capacity_wait;
}

export const DEFAULT_HOST_NAME = "窩室 OurSpace";
export const DEFAULT_FOOTER_TEXT = "本報名系統由 窩室 OurSpace 提供";
