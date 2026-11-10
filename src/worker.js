/* =========================================================
   OurSpace.Co-op Worker 入口
   /api/auth/*     LINE 登入、驗證碼
   /api/admin/*    後台
   /api/public/*   前台（免登入）、/api/images/*
   /u/:code        單位頁（public/unit.html）
   其他            靜態檔案（public/）
========================================================= */

import { handleAuthApi } from "./auth.js";
import { handleAdminApi } from "./admin-api.js";
import { handlePublicApi } from "./public-api.js";
import { fail, taiwanNow } from "./util.js";

const RETENTION_DAYS = 183;


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (/^\/u\/[A-Za-z0-9]{3,12}(\/register)?\/?$/.test(path)) {
      return env.ASSETS.fetch(new Request(new URL("/unit", url), request));
    }

    if (path.indexOf("/api/") !== 0) {
      return env.ASSETS.fetch(request);
    }

    try {
      let response = null;
      if (path.indexOf("/api/auth/") === 0) response = await handleAuthApi(request, url, env);
      else if (path.indexOf("/api/admin/") === 0) response = await handleAdminApi(request, url, env);
      else response = await handlePublicApi(request, url, env);
      return response || fail("API_NOT_FOUND", 404);
    } catch (error) {
      console.error("Worker error:", error);
      if (String(error && error.message).indexOf("no such table") !== -1) return fail("DATABASE_NOT_READY", 500);
      return fail("INTERNAL_SERVER_ERROR", 500);
    }
  },

  /* 每天執行：清除過期登入；合作結束滿 6 個月的單位，刪除姓名與手機 */
  async scheduled(event, env) {
    const cutoff = taiwanNow(-RETENTION_DAYS * 24 * 3600 * 1000);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
      env.DB.prepare(
        "UPDATE entries SET name = NULL, phone = NULL, email = NULL, updated_at = CURRENT_TIMESTAMP " +
        "WHERE unit_id IN (SELECT id FROM units WHERE end_at <= ? AND purged_at IS NULL)"
      ).bind(cutoff),
      env.DB.prepare("UPDATE units SET purged_at = ? WHERE end_at <= ? AND purged_at IS NULL").bind(taiwanNow(), cutoff)
    ]);
  }
};
