/* =========================================================
   OurSpace.Co-op 後台（手機優先）
   #/                     首頁：我的單位、輸入驗證碼
   #/new                  新增單位（系統管理員）
   #/system               個資／肖像權說明（系統管理員）
   #/unit/:id/entries     報名名單
   #/unit/:id/members     成員與驗證碼（單位管理員以上）
   #/unit/:id/settings    單位設定（系統管理員）
========================================================= */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var toastBox = document.getElementById("toast");
  var me = null;
  var toastTimer = null;

  var ROLE_LABEL = { sysadmin: "系統管理員", admin: "單位管理員", staff: "工作人員" };
  var STATUS_LABEL = { main: "正取", wait: "備取", cancelled: "已取消" };

  var ERRORS = {
    NOT_LOGGED_IN: "登入已過期，請重新登入。",
    FORBIDDEN: "沒有權限執行這個動作。",
    CODE_INVALID: "驗證碼不正確。",
    CODE_LOCKED: "輸入錯誤太多次，請 15 分鐘後再試。",
    CODE_TAKEN: "這個單位代碼已經有人使用了。",
    INVALID_FIELDS: "有欄位沒填或格式不對，請檢查標示的欄位。",
    MAIN_FULL: "正取已滿。",
    ALREADY_REGISTERED: "這位報名者的暱稱或手機已被其他報名使用，無法恢復。",
    IMAGE_TOO_LARGE: "圖片超過 1MB。",
    INVALID_IMAGE: "只能上傳 PNG、JPG、WebP 圖片。",
    DATABASE_NOT_READY: "資料庫還沒建表，請到 D1 Console 貼上建表語法。",
    NETWORK: "連線失敗，請檢查網路後再試一次。"
  };

  var LOGIN_ERRORS = {
    login: "LINE 登入沒有完成，請再試一次。",
    disabled: "這個帳號已停用。",
    "line-not-configured": "LINE 登入尚未設定（缺少 LINE_CHANNEL_ID 或 LINE_CHANNEL_SECRET）。"
  };

  /* ---------- 工具 ---------- */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? "" : value);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function render(nodes, withTabs) {
    app.textContent = "";
    app.className = "page admin" + (withTabs ? " with-tabs" : "");
    nodes.forEach(function (n) { if (n) app.appendChild(n); });
  }

  function toast(message) {
    toastBox.textContent = message;
    toastBox.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastBox.classList.remove("show"); }, 2600);
  }

  function errorText(result) {
    if (result.error === "CODE_INVALID" && result.remaining !== undefined) {
      return "驗證碼不正確，還可以再試 " + result.remaining + " 次。";
    }
    return ERRORS[result.error] || ("發生錯誤（" + result.error + "）");
  }

  function api(method, path, body) {
    var options = { method: method, headers: { "X-Coop-Admin": "1" }, credentials: "same-origin" };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return { success: false, error: "NETWORK" }; });
    }).catch(function () {
      return { success: false, error: "NETWORK" };
    }).then(function (result) {
      if (result.error === "NOT_LOGGED_IN") { me = null; location.hash = "#/"; renderLogin(); }
      return result;
    });
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("已複製"); }, function () { prompt("請手動複製：", text); });
    } else {
      prompt("請手動複製：", text);
    }
  }

  function toInput(value) { return value ? String(value).replace(" ", "T") : ""; }

  var ICONS = {
    back: '<path d="M15 18l-6-6 6-6"></path>',
    list: '<path d="M8 6h12"></path><path d="M8 12h12"></path><path d="M8 18h12"></path><circle cx="4" cy="6" r="1"></circle><circle cx="4" cy="12" r="1"></circle><circle cx="4" cy="18" r="1"></circle>',
    users: '<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"></path><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"></path><path d="M18 14.3c2.1.7 3.5 2.8 3.5 5.7"></path>',
    gear: '<circle cx="12" cy="12" r="3"></circle><path d="M12 3v3"></path><path d="M12 18v3"></path><path d="M3 12h3"></path><path d="M18 12h3"></path><path d="M5.6 5.6l2.1 2.1"></path><path d="M16.3 16.3l2.1 2.1"></path><path d="M5.6 18.4l2.1-2.1"></path><path d="M16.3 7.7l2.1-2.1"></path>'
  };

  function icon(name, size) {
    var span = document.createElement("span");
    span.setAttribute("aria-hidden", "true");
    span.style.display = "inline-flex";
    span.innerHTML = '<svg width="' + (size || 22) + '" height="' + (size || 22) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + "</svg>";
    return span;
  }

  function header(title, sub, backHash) {
    return el("header", { class: "appbar admin-bar" }, [
      el("div", { class: "admin-bar-inner" }, [
        backHash ? el("a", { class: "icon-btn", href: backHash, "aria-label": "返回" }, [icon("back")]) : el("span", { style: "width:12px" }),
        el("div", { class: "appbar-title" }, [el("b", { text: title }), sub ? el("span", { text: sub }) : null]),
        me && !backHash ? el("div", { class: "top-actions" }, [
          me.user.picture ? el("img", { class: "avatar", src: me.user.picture, alt: "" }) : null,
          el("button", { class: "btn ghost small", type: "button", onclick: logout }, ["登出"])
        ]) : null
      ])
    ]);
  }

  function logout() {
    api("POST", "/api/auth/logout").then(function () { me = null; location.hash = "#/"; renderLogin(); });
  }

  /* ---------- 登入 ---------- */
  function renderLogin(errorKey) {
    render([
      header("協辦後台", "窩室 OurSpace"),
      el("main", { class: "content" }, [
        errorKey && LOGIN_ERRORS[errorKey] ? el("div", { class: "alert", role: "alert", text: LOGIN_ERRORS[errorKey] }) : null,
        el("section", { class: "card" }, [
          el("h2", { text: "用 LINE 登入" }),
          el("p", { class: "text", style: "margin:0", text: "後台只開放主辦單位的管理員與工作人員使用。第一次登入後，請輸入主辦單位給你的驗證碼。" }),
          el("a", { class: "btn", href: "/api/auth/line/start", style: "background:#06C755" }, ["用 LINE 登入"])
        ])
      ])
    ]);
  }

  /* ---------- 首頁 ---------- */
  function joinCard(prominent) {
    var input = el("input", { id: "join-code", type: "text", autocomplete: "off", autocapitalize: "characters", maxlength: "32", placeholder: "例如 K7PX3MQA" });
    var errorBox = el("div", { class: "field-error", role: "alert" });

    function submit() {
      errorBox.textContent = "";
      var code = input.value.trim();
      if (!code) { errorBox.textContent = "請輸入驗證碼。"; return; }
      api("POST", "/api/auth/join", { code: code }).then(function (result) {
        if (!result.success) { errorBox.textContent = errorText(result); return; }
        toast(result.data.role === "sysadmin" ? "你已成為系統管理員" : "已加入「" + result.data.unit_name + "」（" + ROLE_LABEL[result.data.role] + "）");
        loadMe().then(route);
      });
    }

    return el("section", { class: "card" }, [
      el("h2", { text: prominent ? "輸入驗證碼" : "加入其他單位" }),
      prominent ? el("p", { class: "text", style: "margin:0", text: "請向主辦單位索取驗證碼，輸入後就能看到該單位的報名名單。" }) : null,
      el("div", { class: "field" }, [el("label", { for: "join-code", text: "驗證碼" }), input, errorBox]),
      el("button", { class: "btn", type: "button", onclick: submit }, ["加入"])
    ]);
  }

  function renderHome() {
    var units = me.units;
    var isSys = me.user.is_sysadmin;

    var list = units.map(function (u) {
      var ending = u.end_at <= me.soon;
      return el("section", { class: "card" }, [
        el("a", { class: "unit-link", href: "#/unit/" + u.id + "/entries" }, [
          el("span", { class: "unit-title", text: u.name }),
          el("span", { class: "text", style: "font-size:14px", text: u.event_title }),
          el("span", { class: "role", text: ROLE_LABEL[u.role] + "　合作期間 " + u.start_at + " ～ " + u.end_at })
        ]),
        ending && u.end_at > me.now ? el("div", { class: "warn", text: "合作期間將於 " + u.end_at + " 結束，結束後所有成員都無法登入此單位。" }) : null,
        isSys && (u.end_at <= me.now || u.start_at > me.now) ? el("div", { class: "role", text: u.end_at <= me.now ? "已結束（只有系統管理員看得到）" : "尚未開始" }) : null
      ]);
    });

    render([
      header("協辦後台", me.user.name + "・" + (isSys ? "系統管理員" : "已登入")),
      el("main", { class: "content" }, [
        isSys ? el("div", { class: "two" }, [
          el("a", { class: "btn", href: "#/new" }, ["新增單位"]),
          el("a", { class: "btn ghost", href: "#/system" }, ["個資說明設定"])
        ]) : null,
        list.length ? el("div", { style: "display:flex;flex-direction:column;gap:12px" }, list) : null,
        !list.length && isSys ? el("p", { class: "empty", text: "還沒有任何單位，先新增一個吧。" }) : null,
        joinCard(!list.length && !isSys)
      ])
    ]);
  }

  /* ---------- 單位頁框架 ---------- */
  var unitCache = null;

  function loadUnit(id) {
    return api("GET", "/api/admin/units/" + id).then(function (result) {
      if (!result.success) {
        render([header("找不到單位", null, "#/"), el("main", { class: "content" }, [el("div", { class: "alert", text: errorText(result) })])]);
        return null;
      }
      unitCache = result.data;
      document.documentElement.style.setProperty("--accent", unitCache.accent || "#0F6E6E");
      return unitCache;
    });
  }

  function unitShell(unit, tab, body) {
    var tabs = [["entries", "名單", "list"]];
    if (unit.role === "sysadmin" || unit.role === "admin") tabs.push(["members", "成員", "users"]);
    if (unit.role === "sysadmin") tabs.push(["settings", "設定", "gear"]);

    render([
      header(unit.name, unit.event_title + "・" + ROLE_LABEL[unit.role], "#/"),
      tabs.length > 1 ? el("nav", { class: "admin-tabs", "aria-label": "單位功能" }, [
        el("div", { class: "admin-tabs-inner" }, tabs.map(function (t) {
          return el("a", {
            class: "admin-tab", href: "#/unit/" + unit.id + "/" + t[0],
            "aria-current": t[0] === tab ? "page" : null
          }, [icon(t[2]), el("span", { text: t[1] })]);
        }))
      ]) : null,
      el("main", { class: "content" }, body)
    ], tabs.length > 1);
  }

  /* ---------- 報名名單 ---------- */
  var entryFilter = "all";

  function renderEntries(unit) {
    api("GET", "/api/admin/units/" + unit.id + "/entries").then(function (result) {
      if (!result.success) { unitShell(unit, "entries", [el("div", { class: "alert", text: errorText(result) })]); return; }

      var data = result.data;
      var all = data.entries;
      var cancelled = all.filter(function (e) { return e.status === "cancelled"; }).length;
      var shown = all.filter(function (e) { return entryFilter === "all" ? e.status !== "cancelled" : e.status === entryFilter; });
      var canEdit = data.show_contact;

      function filterButton(key, label) {
        return el("button", {
          class: "filter", type: "button", "aria-pressed": entryFilter === key ? "true" : "false",
          onclick: function () { entryFilter = key; renderEntries(unit); }
        }, [label]);
      }

      function changeStatus(entry, status, force) {
        api("POST", "/api/admin/entries/" + entry.id + "/status", { status: status, force: !!force }).then(function (r) {
          if (r.success) { toast(entry.display + " → " + STATUS_LABEL[status]); renderEntries(unit); return; }
          if (r.error === "MAIN_FULL" && confirm("正取已滿（" + data.counts.main + " / " + unit.capacity_main + "），仍要把「" + entry.display + "」遞補為正取嗎？")) {
            changeStatus(entry, status, true);
            return;
          }
          if (r.error !== "MAIN_FULL") toast(errorText(r));
        });
      }

      var rows = shown.map(function (e) {
        var chipText = e.status === "wait" ? "備取 " + e.wait_no : STATUS_LABEL[e.status];
        var actions = [];
        if (canEdit) {
          if (e.status === "wait") actions.push(el("button", { class: "btn small", type: "button", onclick: function () { changeStatus(e, "main"); } }, ["遞補為正取"]));
          if (e.status === "main") actions.push(el("button", { class: "btn ghost small", type: "button", onclick: function () { if (confirm("把「" + e.display + "」改為備取？")) changeStatus(e, "wait"); } }, ["改為備取"]));
          if (e.status !== "cancelled") actions.push(el("button", { class: "btn ghost small", type: "button", onclick: function () { if (confirm("取消「" + e.display + "」的報名？")) changeStatus(e, "cancelled"); } }, ["取消報名"]));
          if (e.status === "cancelled") actions.push(el("button", { class: "btn ghost small", type: "button", onclick: function () { changeStatus(e, "wait"); } }, ["恢復為備取"]));
          actions.push(el("button", {
            class: "btn ghost small danger", type: "button",
            onclick: function () {
              if (!confirm("永久刪除「" + e.display + "」的報名資料？刪除後無法復原。")) return;
              api("DELETE", "/api/admin/entries/" + e.id).then(function (r) { toast(r.success ? "已刪除" : errorText(r)); renderEntries(unit); });
            }
          }, ["刪除"]));
        }

        return el("div", { class: "entry" + (canEdit ? "" : " no-contact"), role: "row" }, [
          el("span", { class: "c-id", role: "cell", text: String(e.id) }),
          el("span", { class: "c-name", role: "cell", text: e.display }),
          el("span", { class: "c-status", role: "cell" }, [el("span", { class: "chip " + e.status, text: chipText })]),
          el("div", { class: "c-meta" }, [
            canEdit ? el("span", { class: "c-real", role: "cell", text: e.name || "—" }) : null,
            canEdit ? el("span", { class: "c-phone", role: "cell" }, [e.phone ? el("a", { href: "tel:" + e.phone, text: e.phone }) : "—"]) : null,
            canEdit ? el("span", { class: "c-email", role: "cell" }, [e.email ? el("a", { href: "mailto:" + e.email, text: e.email }) : "—"]) : null,
            el("span", { class: "c-time", role: "cell", text: e.created_at })
          ]),
          canEdit ? el("div", { class: "c-actions", role: "cell" }, actions) : null
        ]);
      });

      unitShell(unit, "entries", [
        el("div", { class: "stats" }, [
          el("div", { class: "stat" }, [el("b", { text: data.counts.main + " / " + unit.capacity_main }), el("span", { text: "正取" })]),
          el("div", { class: "stat" }, [el("b", { text: data.counts.wait + " / " + (unit.capacity_wait < 0 ? "不限" : unit.capacity_wait) }), el("span", { text: "備取" })]),
          el("div", { class: "stat" }, [el("b", { text: String(cancelled) }), el("span", { text: "已取消" })])
        ]),
        el("div", { class: "toolbar" }, [
        el("div", { class: "filters" }, [
          filterButton("all", "全部"), filterButton("main", "正取"), filterButton("wait", "備取"), filterButton("cancelled", "已取消")
        ]),
        el("div", { class: "toolbar-actions" }, [
          el("button", { class: "btn ghost", type: "button", onclick: function () { renderEntries(unit); } }, ["重新整理"]),
          canEdit ? el("a", { class: "btn", href: "/api/admin/units/" + unit.id + "/export" }, ["匯出 CSV"]) : el("a", { class: "btn ghost", href: "/u/" + unit.code, target: "_blank", rel: "noopener" }, ["開啟活動頁"])
        ])
        ]),
        canEdit ? null : el("p", { class: "hint", style: "margin:0", text: "工作人員看不到報名者的姓名與手機。" }),
        rows.length ? el("div", { class: "entries", role: "table", "aria-label": "報名名單" }, [
          el("div", { class: "entry entry-head" + (canEdit ? "" : " no-contact"), role: "row" }, [
            el("span", { class: "c-id", role: "columnheader", text: "編號" }),
            el("span", { class: "c-name", role: "columnheader", text: "名稱" }),
            el("span", { class: "c-status", role: "columnheader", text: "狀態" }),
            el("div", { class: "c-meta" }, [
              canEdit ? el("span", { class: "c-real", role: "columnheader", text: "姓名" }) : null,
              canEdit ? el("span", { class: "c-phone", role: "columnheader", text: "手機" }) : null,
              canEdit ? el("span", { class: "c-email", role: "columnheader", text: "Email" }) : null,
              el("span", { class: "c-time", role: "columnheader", text: "報名時間" })
            ]),
            canEdit ? el("span", { class: "c-actions", role: "columnheader", text: "操作" }) : null
          ])
        ].concat(rows)) : el("p", { class: "empty", text: "目前沒有報名資料。" })
      ]);
    });
  }

  /* ---------- 成員與驗證碼 ---------- */
  function renderMembers(unit) {
    api("GET", "/api/admin/units/" + unit.id + "/members").then(function (result) {
      var members = result.success ? result.data : [];
      var adminUrl = location.origin + "/admin/";

      function codeCard(kind, title, desc, code) {
        return el("section", { class: "card" }, [
          el("h2", { text: title }),
          el("p", { class: "text", style: "margin:0", text: desc }),
          el("div", { class: "code-box" }, [
            code ? el("span", { class: "code-value", text: code }) : el("span", { class: "code-off", text: "已停用" }),
            code ? el("button", {
              class: "btn ghost small", type: "button",
              onclick: function () { copy("請用手機開啟 " + adminUrl + " ，用 LINE 登入後輸入驗證碼：" + code); }
            }, ["複製邀請訊息"]) : null
          ]),
          el("div", { class: "row-actions" }, [
            el("button", { class: "btn ghost small", type: "button", onclick: function () { codeAction(kind, "regenerate"); } }, [code ? "換新碼" : "產生新碼"]),
            code ? el("button", { class: "btn ghost small danger", type: "button", onclick: function () { codeAction(kind, "disable"); } }, ["停用"]) : null
          ])
        ]);
      }

      function codeAction(kind, action) {
        var message = action === "regenerate" ? "換新碼後，舊的驗證碼立刻失效（已加入的成員不受影響）。確定嗎？" : "停用後，沒有人能再用驗證碼加入（已加入的成員不受影響）。確定嗎？";
        if (!confirm(message)) return;
        api("POST", "/api/admin/units/" + unit.id + "/codes", { kind: kind, action: action }).then(function (r) {
          if (!r.success) { toast(errorText(r)); return; }
          if (kind === "admin") unit.admin_code = r.data.code; else unit.staff_code = r.data.code;
          toast(action === "regenerate" ? "已換新碼" : "已停用");
          renderMembers(unit);
        });
      }

      var memberRows = members.map(function (m) {
        return el("div", { class: "member" }, [
          m.picture ? el("img", { class: "avatar", src: m.picture, alt: "" }) : el("span", { class: "avatar" }),
          el("div", { class: "member-name" }, [
            el("div", { text: m.name }),
            el("div", { class: "role", text: ROLE_LABEL[m.role] + "・" + m.joined_at + " 加入" })
          ]),
          el("button", {
            class: "btn ghost small danger", type: "button",
            onclick: function () {
              var self = me.user.id === m.id;
              if (!confirm(self ? "要把自己移出這個單位嗎？移出後你就看不到這個單位了。" : "把「" + m.name + "」移出這個單位？")) return;
              api("DELETE", "/api/admin/units/" + unit.id + "/members/" + m.id).then(function (r) {
                toast(r.success ? "已移除" : errorText(r));
                if (self && !me.user.is_sysadmin) { loadMe().then(function () { location.hash = "#/"; }); return; }
                renderMembers(unit);
              });
            }
          }, ["移除"])
        ]);
      });

      unitShell(unit, "members", [
        unit.role === "sysadmin" ? codeCard("admin", "單位管理員碼", "輸入後成為單位管理員：可看姓名與手機、匯出名單、遞補備取、管理成員。只給主辦單位的負責人。", unit.admin_code) : null,
        codeCard("staff", "工作人員碼", "輸入後成為工作人員：只看得到暱稱與正取／備取，看不到姓名與手機。", unit.staff_code),
        el("section", { class: "card" }, [
          el("h2", { text: "成員（" + members.length + "）" }),
          memberRows.length ? el("div", null, memberRows) : el("p", { class: "empty", text: "還沒有成員加入。" })
        ])
      ]);
    });
  }

  /* ---------- 單位設定／新增單位 ---------- */
  function renderUnitForm(unit) {
    var isNew = !unit;
    var data = Object.assign({}, unit || {
      accent: "#0F6E6E", reg_open: 1, capacity_main: 32, capacity_wait: -1, max_per_submit: 5,
      nickname_required: 1, phone_required: 1, email_required: 0,
      host_show: 1, host_label: "協辦", host_name: "窩室 OurSpace",
      footer_show: 1, footer_text: "本報名系統由 窩室 OurSpace 提供"
    });
    if (data.capacity_wait < 0) data.capacity_wait = "";
    var checks = {};
    var images = { logo: data.logo_image_id || null, cover: data.cover_image_id || null };
    var inputs = {};
    var errorBox = el("div", { role: "alert" });

    function field(key, label, type, opts) {
      opts = opts || {};
      var id = "u-" + key;
      var value = data[key] === null || data[key] === undefined ? "" : data[key];
      var input;
      if (type === "textarea") {
        input = el("textarea", { id: id, maxlength: opts.max || "3000" });
        input.value = value;
      } else {
        input = el("input", Object.assign({ id: id, type: type, value: type === "datetime-local" ? toInput(value) : value }, opts.attrs || {}));
      }
      inputs[key] = input;
      return el("div", { class: "field" }, [
        el("label", { for: id }, [label, opts.required ? el("span", { class: "req", text: " *" }) : null]),
        input,
        opts.hint ? el("div", { class: "hint", text: opts.hint }) : null
      ]);
    }

    function imageField(kind, label, wide) {
      var preview = el("img", { class: wide ? "wide" : "", alt: "", src: images[kind] ? "/api/images/" + images[kind] : null });
      var file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", id: "img-" + kind, style: "max-width:100%" });
      var status = el("span", { class: "hint" });
      file.addEventListener("change", function () {
        if (!file.files || !file.files[0]) return;
        status.textContent = "上傳中…";
        uploadImage(file.files[0], kind === "cover" ? 2000 : 1600).then(function (r) {
          if (!r.success) { status.textContent = errorText(r); return; }
          images[kind] = r.data.id;
          preview.src = r.data.url;
          status.textContent = "已上傳，記得按儲存";
        });
      });
      return el("div", { class: "field" }, [
        el("label", { for: "img-" + kind, text: label }),
        el("div", { class: "image-pick" }, [
          preview,
          file,
          el("button", { class: "btn ghost small", type: "button", onclick: function () { images[kind] = null; preview.removeAttribute("src"); status.textContent = "已移除，記得按儲存"; } }, ["移除"])
        ]),
        status
      ]);
    }

    var regOpen = el("input", { type: "checkbox", id: "u-reg_open", checked: !!data.reg_open });

    function checkbox(key, label) {
      var input = el("input", { type: "checkbox", id: "u-" + key, checked: !!data[key] });
      checks[key] = input;
      return el("label", { class: "check", for: "u-" + key }, [input, el("span", { text: label })]);
    }

    var hostLabel = el("select", { id: "u-host_label" }, [
      el("option", { value: "協辦", text: "協辦" }),
      el("option", { value: "主辦", text: "主辦" })
    ]);
    hostLabel.value = data.host_label === "主辦" ? "主辦" : "協辦";

    function save() {
      errorBox.textContent = "";
      var body = {};
      Object.keys(inputs).forEach(function (key) { body[key] = inputs[key].value; });
      body.reg_open = regOpen.checked;
      Object.keys(checks).forEach(function (key) { body[key] = checks[key].checked; });
      body.host_label = hostLabel.value;
      body.logo_image_id = images.logo;
      body.cover_image_id = images.cover;

      document.querySelectorAll("[aria-invalid]").forEach(function (n) { n.removeAttribute("aria-invalid"); });

      api(isNew ? "POST" : "PUT", isNew ? "/api/admin/units" : "/api/admin/units/" + unit.id, body).then(function (r) {
        if (!r.success) {
          errorBox.textContent = "";
          var fields = r.fields || [];
          errorBox.appendChild(el("div", { class: "alert", text: fields.indexOf("contact_required") !== -1 ? "手機和 Email 至少要有一個設為必填。" : (fields.indexOf("line_url") !== -1 ? "LINE 官方帳號請填 @帳號ID，或 line.me、lin.ee 開頭的連結。" : errorText(r)) }));
          fields.forEach(function (key) { if (inputs[key]) inputs[key].setAttribute("aria-invalid", "true"); });
          if (fields.indexOf("contact_required") !== -1) { checks.phone_required.setAttribute("aria-invalid", "true"); checks.email_required.setAttribute("aria-invalid", "true"); }
          var first = document.querySelector("[aria-invalid]");
          if (first) first.scrollIntoView({ block: "center" });
          return;
        }
        toast(isNew ? "已建立單位" : "已儲存");
        loadMe().then(function () {
          location.hash = "#/unit/" + (isNew ? r.data.id : unit.id) + (isNew ? "/members" : "/settings");
          if (!isNew) route();
        });
      });
    }

    var body = [
      el("div", { class: "form" }, [
        el("section", { class: "card" }, [
          el("h2", { text: "基本資料" }),
          isNew
            ? field("code", "單位代碼", "text", { required: true, attrs: { maxlength: "12", autocapitalize: "none", autocomplete: "off", placeholder: "例如 abc2612" }, hint: "英文小寫與數字 3～12 碼，會出現在網址 /u/代碼，建立後不能修改。" })
            : el("div", { class: "field" }, [el("span", { class: "hint", text: "單位代碼（不能修改）" }), el("a", { href: "/u/" + unit.code, target: "_blank", rel: "noopener", text: location.origin + "/u/" + unit.code })]),
          field("name", "單位名稱", "text", { required: true, attrs: { maxlength: "60" } }),
          field("event_title", "活動名稱", "text", { required: true, attrs: { maxlength: "80" } }),
          field("event_time", "活動日期與時間", "text", { attrs: { maxlength: "80", placeholder: "例如 2026/12/20（六）13:00" } }),
          field("location", "地點", "text", { attrs: { maxlength: "120" } })
        ]),
        el("section", { class: "card" }, [
          el("h2", { text: "主題" }),
          field("accent", "主色", "color"),
          imageField("logo", "Logo（正方形）", false),
          imageField("cover", "封面圖／海報（橫式、直式都可以）", true),
          el("p", { class: "hint", style: "margin:0", text: "圖片超過 1MB 會自動壓縮。" })
        ]),
        el("section", { class: "card" }, [
          el("h2", { text: "頁首與頁尾" }),
          checkbox("host_show", "在單位名稱下方顯示主辦／協辦"),
          el("div", { class: "two" }, [
            el("div", { class: "field" }, [el("label", { for: "u-host_label", text: "稱謂" }), hostLabel]),
            field("host_name", "名稱", "text", { attrs: { maxlength: "40" } })
          ]),
          checkbox("footer_show", "顯示頁尾文字"),
          field("footer_text", "頁尾文字", "text", { attrs: { maxlength: "80" } })
        ]),
        el("section", { class: "card" }, [
          el("h2", { text: "報名欄位" }),
          el("p", { class: "hint", style: "margin:0", text: "姓名固定必填。手機和 Email 至少要有一個必填；選填欄位有填時一樣會檢查格式與重複。" }),
          checkbox("nickname_required", "參賽暱稱必填"),
          checkbox("phone_required", "手機號碼必填"),
          checkbox("email_required", "Email 必填")
        ]),
        el("section", { class: "card" }, [
          el("h2", { text: "合作期間與報名" }),
          el("div", { class: "two" }, [
            field("start_at", "合作開始", "datetime-local", { required: true }),
            field("end_at", "合作結束", "datetime-local", { required: true })
          ]),
          el("p", { class: "hint", style: "margin:0", text: "合作期間外，活動頁會關閉，成員也無法登入此單位。結束 6 個月後自動刪除報名者姓名與手機。" }),
          el("label", { class: "check", for: "u-reg_open" }, [regOpen, el("span", { text: "開放報名" })]),
          field("reg_deadline", "報名截止", "datetime-local", { hint: "不填就是合作期間內都能報名。" }),
          el("div", { class: "three" }, [
            field("capacity_main", "正取名額", "number", { required: true, attrs: { min: "1", max: "2000", inputmode: "numeric" } }),
            field("capacity_wait", "備取名額", "number", { attrs: { min: "0", max: "2000", inputmode: "numeric", placeholder: "不限" } }),
            field("max_per_submit", "一次最多", "number", { required: true, attrs: { min: "1", max: "10", inputmode: "numeric" } })
          ]),
          el("p", { class: "hint", style: "margin:0", text: "備取名額留空＝無上限，填 0＝不收備取（正取滿就截止）。" })
        ]),
        el("section", { class: "card" }, [
          el("h2", { text: "活動介紹" }),
          field("intro", "介紹", "textarea"),
          field("rules", "賽制", "textarea"),
          field("prizes", "獎品", "textarea"),
          field("notes", "注意事項", "textarea"),
          field("contact", "主辦單位聯絡方式", "textarea", { max: "1000" }),
          field("line_url", "LINE 官方帳號", "text", { attrs: { maxlength: "300", autocapitalize: "none", autocomplete: "off", placeholder: "@帳號ID 或 https://lin.ee/…" }, hint: "有填的話，活動頁會顯示 LINE 加好友按鈕。" })
        ]),
        errorBox,
        el("button", { class: "btn", type: "button", onclick: save }, [isNew ? "建立單位" : "儲存"])
      ])
    ];

    if (isNew) {
      render([header("新增單位", null, "#/"), el("main", { class: "content" }, body)]);
    } else {
      unitShell(unit, "settings", body);
    }
  }

  /* 圖片：≤1MB 且是 PNG/JPG/WebP 直接上傳；否則壓縮成 JPG */
  function uploadImage(file, maxSide) {
    function readBase64(blob) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result).split(",")[1]); };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    function compress() {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        var url = URL.createObjectURL(file);
        img.onload = function () {
          URL.revokeObjectURL(url);
          var scale = Math.min(1, (maxSide || 1600) / Math.max(img.width, img.height));
          var canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var quality = 0.85;
          (function attempt() {
            canvas.toBlob(function (blob) {
              if (!blob) { reject(new Error("compress failed")); return; }
              if (blob.size <= 1000000 || quality < 0.45) resolve(blob);
              else { quality -= 0.1; attempt(); }
            }, "image/jpeg", quality);
          })();
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("bad image")); };
        img.src = url;
      });
    }

    var okType = ["image/png", "image/jpeg", "image/webp"].indexOf(file.type) !== -1;
    var ready = okType && file.size <= 1000000 ? Promise.resolve(file) : compress();

    return ready.then(readBase64).then(function (data) {
      return api("POST", "/api/admin/images", { data: data });
    }).catch(function () {
      return { success: false, error: "INVALID_IMAGE" };
    });
  }

  /* ---------- 系統設定 ---------- */
  function renderSystem() {
    api("GET", "/api/admin/settings").then(function (result) {
      if (!result.success) { render([header("個資說明設定", null, "#/"), el("main", { class: "content" }, [el("div", { class: "alert", text: errorText(result) })])]); return; }

      var privacy = el("textarea", { id: "s-privacy", style: "min-height:260px" });
      var portrait = el("textarea", { id: "s-portrait", style: "min-height:180px" });
      privacy.value = result.data.privacy;
      portrait.value = result.data.portrait;

      render([
        header("個資說明設定", "所有單位共用", "#/"),
        el("main", { class: "content" }, [
          el("p", { class: "hint", style: "margin:0", text: "文字中的 {單位} 會自動換成各單位名稱。修改後存成新版本，之前的報名紀錄仍對應當時同意的版本。" }),
          el("div", { class: "form" }, [
            el("div", { class: "field" }, [el("label", { for: "s-privacy", text: "個資使用說明" }), privacy]),
            el("div", { class: "field" }, [el("label", { for: "s-portrait", text: "肖像權使用說明" }), portrait]),
            el("button", {
              class: "btn", type: "button",
              onclick: function () {
                api("PUT", "/api/admin/settings", { privacy: privacy.value, portrait: portrait.value }).then(function (r) {
                  toast(r.success ? (r.data.changed ? "已儲存新版本" : "內容沒有變更") : errorText(r));
                });
              }
            }, ["儲存"])
          ])
        ])
      ]);
    });
  }

  /* ---------- 路由 ---------- */
  function loadMe() {
    return api("GET", "/api/auth/me").then(function (result) {
      me = result.success && result.data.user ? result.data : null;
    });
  }

  function route() {
    var hash = location.hash || "#/";
    document.documentElement.style.setProperty("--accent", "#0F6E6E");

    var errorMatch = hash.match(/^#error=([a-z-]+)/);
    if (!me) { renderLogin(errorMatch ? errorMatch[1] : null); return; }
    if (errorMatch) { location.hash = "#/"; return; }

    if (hash === "#/new") { if (me.user.is_sysadmin) renderUnitForm(null); else location.hash = "#/"; return; }
    if (hash === "#/system") { if (me.user.is_sysadmin) renderSystem(); else location.hash = "#/"; return; }

    var unitMatch = hash.match(/^#\/unit\/(\d+)\/(entries|members|settings)$/);
    if (unitMatch) {
      loadUnit(unitMatch[1]).then(function (unit) {
        if (!unit) return;
        var tab = unitMatch[2];
        if (tab === "members" && unit.role === "staff") tab = "entries";
        if (tab === "settings" && unit.role !== "sysadmin") tab = "entries";
        if (tab === "entries") renderEntries(unit);
        else if (tab === "members") renderMembers(unit);
        else renderUnitForm(unit);
      });
      return;
    }

    renderHome();
  }

  window.addEventListener("hashchange", route);
  loadMe().then(route);
})();
