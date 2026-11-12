/* =========================================================
   OurSpace.Co-op 前台
   /u/代碼            活動頁
   /u/代碼/register   報名（步驟 1 填資料 → 步驟 2 同意與送出 → 完成）
========================================================= */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var match = location.pathname.match(/^\/u\/([A-Za-z0-9]{3,12})/);
  var code = match ? match[1].toLowerCase() : "";
  var base = "/u/" + code;

  var unit = null;
  var footerConfig = null;
  var people = [];
  var agree = { privacy: false, portrait: false };
  var step = 1;
  var activeTab = 0;
  var turnstileToken = "";
  var turnstileWidget = null;

  var FIELD_LABELS = { name: "姓名", nickname: "參賽暱稱", phone: "手機號碼", email: "Email" };

  var PERSON_ERRORS = {
    REQUIRED: "請填寫此欄位",
    TOO_LONG_name: "姓名最多 30 個字",
    TOO_LONG_nickname: "暱稱最多 20 個字",
    TOO_LONG_email: "Email 太長了",
    INVALID_PHONE: "請輸入 09 開頭的 10 碼手機號碼",
    INVALID_EMAIL: "Email 格式不正確",
    DUPLICATE_IN_FORM_nickname: "這次報名裡已經有相同暱稱",
    DUPLICATE_IN_FORM_phone: "這次報名裡已經有相同手機號碼",
    DUPLICATE_IN_FORM_email: "這次報名裡已經有相同 Email",
    NICKNAME_TAKEN: "這個暱稱已經有人使用，請換一個",
    PHONE_TAKEN: "這支手機號碼已經報名過了",
    EMAIL_TAKEN: "這個 Email 已經報名過了"
  };

  var ERRORS = {
    CONSENT_REQUIRED: "請勾選同意個資與肖像權使用說明。",
    CONSENT_CHANGED: "說明文字剛剛更新了，請重新整理頁面後再送出。",
    REG_CLOSED: "目前沒有開放報名。",
    REG_DEADLINE: "報名已經截止。",
    REG_FULL: "名額已滿，無法再報名。",
    TURNSTILE_FAILED: "驗證沒有通過，請重新完成驗證後再送出。",
    ALREADY_REGISTERED: "有報名者的資料剛剛被使用了，請檢查後再送出。",
    TOO_MANY_PEOPLE: "一次報名的人數超過上限。",
    UNIT_NOT_FOUND: "找不到這個活動。"
  };

  var REG_TEXT = { open: "報名中", closed: "未開放報名", deadline: "報名已截止", full: "名額已滿" };

  var ICONS = {
    back: '<path d="M15 18l-6-6 6-6"></path>',
    share: '<path d="M12 15V4"></path><path d="M8 8l4-4 4 4"></path><path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"></path>',
    cal: '<rect x="3.5" y="5" width="17" height="15" rx="3"></rect><path d="M3.5 10h17"></path><path d="M8 3v4"></path><path d="M16 3v4"></path>',
    pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"></path><circle cx="12" cy="10" r="2.5"></circle>',
    clock: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path>',
    plus: '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
    check: '<path d="M5 12l5 5L19 7"></path>',
    close: '<path d="M6 6l12 12"></path><path d="M18 6L6 18"></path>'
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

  function icon(name, size) {
    var span = document.createElement("span");
    span.setAttribute("aria-hidden", "true");
    span.style.display = "inline-flex";
    span.innerHTML = '<svg width="' + (size || 22) + '" height="' + (size || 22) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + "</svg>";
    return span;
  }

  function render(nodes, withBar) {
    app.textContent = "";
    app.className = "page" + (withBar ? " with-bar" : "");
    nodes.forEach(function (n) { if (n) app.appendChild(n); });
  }

  function formatTime(text) {
    if (!text) return "";
    var d = new Date(text.replace(" ", "T") + ":00");
    if (isNaN(d.getTime())) return text;
    return text.slice(0, 10).replace(/-/g, "/") + "（" + "日一二三四五六".charAt(d.getDay()) + "）" + text.slice(11, 16);
  }

  function shortTime(text) {
    var full = formatTime(text);
    return full.length > 5 ? full.slice(5) : full;
  }

  function api(path, options) {
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return { success: false, error: "NETWORK" }; });
    }).catch(function () {
      return { success: false, error: "NETWORK" };
    });
  }

  var toastTimer = null;
  function toast(text) {
    var box = document.getElementById("toast");
    if (!box) {
      box = el("div", { id: "toast", role: "status", "aria-live": "polite", style: "position:fixed;left:50%;bottom:calc(100px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:#14161A;color:#fff;padding:10px 16px;border-radius:999px;font-size:14px;z-index:200;transition:opacity .2s;opacity:0;pointer-events:none" });
      document.body.appendChild(box);
    }
    box.textContent = text;
    box.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.style.opacity = "0"; }, 2200);
  }

  function share() {
    var data = { title: unit.event_title, url: location.origin + base };
    if (navigator.share) {
      navigator.share(data).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(data.url).then(function () { toast("已複製活動連結"); });
    }
  }

  /* ---------- 共用區塊 ---------- */
  function footer() {
    var config = unit ? unit.footer : footerConfig;
    if (!config || !config.show || !config.text) return null;
    return el("footer", { class: "foot", text: config.text });
  }

  function statePage(title, message) {
    render([
      el("main", { class: "state-page" }, [el("h1", { text: title }), message ? el("p", { class: "hint", text: message }) : null]),
      footer()
    ]);
  }

  function orgBlock() {
    var logo = unit.logo_url
      ? el("img", { class: "org-logo", src: unit.logo_url, alt: "" })
      : el("div", { class: "org-logo", "aria-hidden": "true", text: Array.from(unit.name || "?")[0] });
    return el("div", { class: "org" }, [
      logo,
      el("div", { class: "org-text" }, [
        el("b", { text: unit.name }),
        unit.host && unit.host.show ? el("span", { text: unit.host.label + "：" + unit.host.name }) : null
      ])
    ]);
  }

  function appbar(title, sub, onBack, stepText) {
    return el("header", { class: "appbar" }, [
      onBack ? el("button", { class: "icon-btn", type: "button", "aria-label": "返回", onclick: onBack }, [icon("back")]) : el("span", { style: "width:12px" }),
      el("div", { class: "appbar-title" }, [el("b", { text: title }), sub ? el("span", { text: sub }) : null]),
      stepText ? el("span", { class: "appbar-step", text: stepText }) : null
    ]);
  }

  function regButton(cls) {
    var open = unit.reg_state === "open";
    return el("button", {
      class: "btn " + (cls || ""), type: "button", disabled: !open,
      onclick: function () { step = 1; go(base + "/register"); }
    }, [open ? "立即報名" : REG_TEXT[unit.reg_state]]);
  }

  function openLightbox(src) {
    var box = el("div", { class: "lightbox", role: "dialog", "aria-label": "活動海報", onclick: close }, [
      el("img", { src: src, alt: "活動海報" }),
      el("button", { class: "glass-btn", type: "button", "aria-label": "關閉", onclick: close }, [icon("close")])
    ]);
    function close() { box.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    document.body.appendChild(box);
  }

  /* ---------- 活動頁 ---------- */
  function renderIntro() {
    document.title = unit.event_title + "｜" + unit.name;
    var open = unit.reg_state === "open";

    var infoRows = [];
    if (unit.event_time) infoRows.push(["cal", "活動時間", unit.event_time]);
    if (unit.location) infoRows.push(["pin", "地點", unit.location]);
    if (unit.reg_deadline) infoRows.push(["clock", "報名截止", formatTime(unit.reg_deadline)]);

    var sections = [["活動介紹", unit.intro], ["賽制", unit.rules], ["獎品", unit.prizes], ["注意事項", unit.notes]]
      .filter(function (s) { return s[1]; });
    if (activeTab >= sections.length) activeTab = 0;

    var tabsNode = null;
    if (sections.length > 1) {
      tabsNode = el("section", null, [
        el("div", { class: "tabs", role: "tablist" }, sections.map(function (s, i) {
          return el("button", {
            class: "tab", type: "button", role: "tab", id: "tab-" + i,
            "aria-selected": i === activeTab ? "true" : "false", "aria-controls": "tab-panel",
            onclick: function () { activeTab = i; renderIntro(); var t = document.getElementById("tab-" + i); if (t) t.focus(); }
          }, [s[0]]);
        })),
        el("div", { class: "tab-panel", id: "tab-panel", role: "tabpanel", "aria-labelledby": "tab-" + activeTab, text: sections[activeTab][1] })
      ]);
    } else if (sections.length === 1) {
      tabsNode = el("section", { style: "display:flex;flex-direction:column;gap:10px" }, [
        el("h2", { class: "section-title", text: sections[0][0] }),
        el("div", { class: "tab-panel", style: "padding-top:0", text: sections[0][1] })
      ]);
    }

    var lineNode = null;
    if (unit.line_url) {
      var img = el("img", { src: "https://scdn.line-apps.com/n/line_add_friends/btn/zh-Hant.png", alt: "加入 LINE 好友" });
      lineNode = el("a", { class: "line-add", href: unit.line_url, target: "_blank", rel: "noopener", "aria-label": "加入主辦單位 LINE 官方帳號" }, [img]);
      img.addEventListener("error", function () {
        lineNode.textContent = "";
        lineNode.className = "btn line small";
        lineNode.appendChild(document.createTextNode("加入 LINE 官方帳號"));
      });
    }

    var contactNode = (unit.contact || lineNode) ? el("section", { class: "contact" }, [
      el("h2", { class: "section-title", text: "主辦單位聯絡方式" }),
      unit.contact ? el("div", { class: "contact-text", text: unit.contact }) : null,
      lineNode
    ]) : null;

    var hero = unit.cover_url ? el("div", { class: "hero" }, [
      el("img", { class: "hero-img", src: unit.cover_url, alt: unit.event_title + " 活動海報", onclick: function () { openLightbox(unit.cover_url); } }),
      el("div", { class: "hero-actions" }, [
        el("button", { class: "glass-btn", type: "button", "aria-label": "分享活動", onclick: share }, [icon("share", 20)])
      ])
    ]) : null;

    var sheet = el("main", { class: "sheet", style: hero ? null : "padding-top:calc(22px + env(safe-area-inset-top,0px))" }, [
      el("span", { class: "status" + (open ? "" : " off"), text: REG_TEXT[unit.reg_state] }),
      el("h1", { class: "title", text: unit.event_title }),
      el("div", { class: "mobile-only" }, [orgBlock()]),
      infoRows.length ? el("div", { class: "info" }, infoRows.map(function (r) {
        return el("div", { class: "info-row" }, [
          el("div", { class: "info-icon" }, [icon(r[0])]),
          el("div", { class: "info-text" }, [el("span", { text: r[1] }), el("b", { text: r[2] })])
        ]);
      })) : null,
      el("div", { class: "deadline-box desk-only" }, [
        el("div", { class: "bottombar-meta" }, unit.reg_deadline
          ? [el("span", { text: "報名截止" }), el("b", { text: formatTime(unit.reg_deadline) })]
          : [el("span", { text: "報名狀態" }), el("b", { text: REG_TEXT[unit.reg_state] })]),
        regButton()
      ]),
      tabsNode,
      contactNode,
      footer()
    ]);

    render([
      el("header", { class: "topnav desk-only", style: "flex-direction:column" }, [
        el("div", { class: "topnav-inner" }, [orgBlock(), regButton()])
      ]),
      el("div", { class: "event-layout" + (hero ? "" : " no-hero") }, [hero, sheet]),
      el("div", { class: "bottombar mobile-only" }, [
        el("div", { class: "bottombar-inner" }, [
          el("div", { class: "bottombar-meta" }, unit.reg_deadline
            ? [el("span", { text: "報名截止" }), el("b", { text: shortTime(unit.reg_deadline) })]
            : [el("span", { text: "報名狀態" }), el("b", { text: REG_TEXT[unit.reg_state] })]),
          regButton("grow")
        ])
      ])
    ], true);
    app.classList.add("event");
  }

  /* ---------- 報名 ---------- */
  function newPerson() { return { name: "", nickname: "", phone: "", email: "", errors: {} }; }

  function isRequired(key) { return key === "name" || !!(unit.fields && unit.fields[key]); }

  function validatePeople() {
    var hasError = false;
    people.forEach(function (person) {
      person.name = person.name.trim();
      person.nickname = person.nickname.trim();
      person.phone = person.phone.replace(/[\s\-()]/g, "");
      person.email = person.email.trim();
      person.errors = {};
      if (!person.name) person.errors.name = PERSON_ERRORS.REQUIRED;
      if (!person.nickname && isRequired("nickname")) person.errors.nickname = PERSON_ERRORS.REQUIRED;
      if (!person.phone) { if (isRequired("phone")) person.errors.phone = PERSON_ERRORS.REQUIRED; }
      else if (!/^09\d{8}$/.test(person.phone)) person.errors.phone = PERSON_ERRORS.INVALID_PHONE;
      if (!person.email) { if (isRequired("email")) person.errors.email = PERSON_ERRORS.REQUIRED; }
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email)) person.errors.email = PERSON_ERRORS.INVALID_EMAIL;
      if (Object.keys(person.errors).length) hasError = true;
    });
    return !hasError;
  }

  function focusFirstError() {
    var first = document.querySelector('[aria-invalid="true"]');
    if (first) { first.scrollIntoView({ block: "center" }); first.focus({ preventScroll: true }); }
  }

  function renderRegister(generalError) {
    if (unit.reg_state !== "open") { renderIntro(); return; }
    if (!people.length) people.push(newPerson());
    document.title = "報名｜" + unit.event_title;
    if (step === 2) { renderConsent(generalError); return; }

    var noticeText = unit.main_full
      ? "正取已額滿，現在報名將列入備取。"
      : (unit.has_wait ? "名額有限，正取額滿後將列入備取。" : "名額有限，額滿為止。");

    var cards = people.map(function (person, index) {
      function field(key, type, extra) {
        var id = "f-" + key + "-" + index;
        var error = person.errors[key];
        return el("div", { class: "field" }, [
          el("label", { for: id }, isRequired(key)
            ? [FIELD_LABELS[key] + " ", el("span", { class: "req", "aria-hidden": "true", text: "*" })]
            : [FIELD_LABELS[key] + " ", el("span", { class: "opt", text: "（選填）" })]),
          el("input", Object.assign({
            id: id, type: type, value: person[key],
            "aria-invalid": error ? "true" : null,
            "aria-describedby": error ? id + "-err" : null,
            oninput: function (event) { person[key] = event.target.value; }
          }, extra || {})),
          key === "nickname" ? el("div", { class: "field-hint", text: isRequired("nickname") ? "會顯示在比賽名單、對戰表" : "會顯示在比賽名單、對戰表；沒填會以遮蔽後的姓名顯示" }) : null,
          error ? el("div", { class: "field-error", id: id + "-err", text: error }) : null
        ]);
      }

      return el("section", { class: "card" }, [
        el("div", { class: "card-head" }, [
          el("h2", { text: "報名者 " + (index + 1) }),
          people.length > 1 ? el("button", { class: "btn ghost small", type: "button", onclick: function () { people.splice(index, 1); renderRegister(); } }, ["移除"]) : null
        ]),
        field("name", "text", { autocomplete: index === 0 ? "name" : "off", maxlength: "30" }),
        field("nickname", "text", { autocomplete: "off", maxlength: "20" }),
        field("phone", "tel", { autocomplete: index === 0 ? "tel" : "off", inputmode: "numeric", maxlength: "12", placeholder: "09xxxxxxxx" }),
        field("email", "email", { autocomplete: index === 0 ? "email" : "off", inputmode: "email", maxlength: "100", autocapitalize: "none", placeholder: "name@example.com" })
      ]);
    });

    render([
      appbar("填寫報名資料", unit.event_title, function () { go(base); }, "步驟 1 / 2"),
      el("div", { class: "progress", "aria-hidden": "true" }, [el("span", { class: "on" }), el("span")]),
      el("main", { class: "form-wrap" }, [
        el("div", { class: "notice" }, [noticeText, unit.reg_deadline ? el("br") : null, unit.reg_deadline ? "報名截止：" + formatTime(unit.reg_deadline) : null]),
        el("div", { style: "display:flex;flex-direction:column;gap:16px" }, cards),
        people.length < unit.max_per_submit
          ? el("button", { class: "btn dashed block", type: "button", onclick: function () { people.push(newPerson()); renderRegister(); } }, [icon("plus", 18), "新增一位報名者"])
          : el("p", { class: "hint center", style: "margin:0", text: "一次最多報名 " + unit.max_per_submit + " 人" }),
        footer()
      ]),
      el("div", { class: "bottombar" }, [
        el("div", { class: "bottombar-inner" }, [
          el("button", {
            class: "btn grow", type: "button",
            onclick: function () {
              if (!validatePeople()) { renderRegister(); focusFirstError(); return; }
              step = 2;
              renderRegister();
              window.scrollTo(0, 0);
            }
          }, ["下一步：同意條款"])
        ])
      ])
    ], true);
  }

  function renderConsent(generalError) {
    var submit = el("button", { class: "btn grow", type: "button", onclick: submitForm }, ["送出報名（" + people.length + " 人）"]);

    render([
      appbar("確認並送出", unit.event_title, function () { step = 1; renderRegister(); window.scrollTo(0, 0); }, "步驟 2 / 2"),
      el("div", { class: "progress", "aria-hidden": "true" }, [el("span", { class: "on" }), el("span", { class: "on" })]),
      el("main", { class: "form-wrap" }, [
        el("section", { class: "card", style: "gap:0;padding-top:6px;padding-bottom:6px" }, people.map(function (p) {
          return el("div", { class: "result-row" }, [
            el("div", { style: "min-width:0" }, [
              el("b", { text: p.nickname || p.name }),
              el("span", { class: "hint", text: [p.name, p.phone, p.email].filter(Boolean).join("・") })
            ])
          ]);
        })),
        el("section", { class: "card" }, [
          el("div", { class: "card-head" }, [el("h2", { text: "個資與肖像權" })]),
          el("div", { class: "consent-text", tabindex: "0", text: unit.consents.privacy ? unit.consents.privacy.body : "" }),
          el("label", { class: "check", for: "agree-privacy" }, [
            el("input", { type: "checkbox", id: "agree-privacy", checked: agree.privacy, onchange: function (e) { agree.privacy = e.target.checked; } }),
            el("span", null, ["我已閱讀並同意個資使用說明 ", el("span", { class: "req", text: "*" })])
          ]),
          el("div", { class: "consent-text", tabindex: "0", text: unit.consents.portrait ? unit.consents.portrait.body : "" }),
          el("label", { class: "check", for: "agree-portrait" }, [
            el("input", { type: "checkbox", id: "agree-portrait", checked: agree.portrait, onchange: function (e) { agree.portrait = e.target.checked; } }),
            el("span", null, ["我同意肖像權使用說明 ", el("span", { class: "req", text: "*" })])
          ]),
          people.length > 1 ? el("p", { class: "hint", style: "margin:0", text: "多人報名時，由送出者代表所有報名者同意，請先取得同行者同意。" }) : null
        ]),
        unit.turnstile_site_key
          ? el("div", { id: "turnstile-box", style: "min-height:66px;display:flex;justify-content:center" })
          : el("div", { class: "alert", text: "報名驗證尚未設定，請聯絡主辦單位。" }),
        generalError ? el("div", { class: "alert", role: "alert", id: "general-error", text: generalError }) : null,
        el("p", { class: "hint center", style: "margin:0", text: "送出後無法自行修改，如需取消請聯絡主辦單位。" }),
        footer()
      ]),
      el("div", { class: "bottombar" }, [el("div", { class: "bottombar-inner" }, [submit])])
    ], true);

    if (!unit.turnstile_site_key) submit.disabled = true;
    mountTurnstile();
    if (generalError) {
      var box = document.getElementById("general-error");
      if (box) box.scrollIntoView({ block: "center" });
    }

    function submitForm() {
      if (!agree.privacy || !agree.portrait) { renderConsent(ERRORS.CONSENT_REQUIRED); return; }
      if (!turnstileToken) { renderConsent("請先完成上方的驗證。"); return; }

      submit.disabled = true;
      submit.textContent = "送出中…";

      api("/api/public/units/" + code + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          people: people.map(function (p) { return { name: p.name, nickname: p.nickname, phone: p.phone, email: p.email }; }),
          agree_privacy: true,
          agree_portrait: true,
          privacy_id: unit.consents.privacy.id,
          portrait_id: unit.consents.portrait.id,
          turnstile: turnstileToken
        })
      }).then(function (result) {
        turnstileToken = "";
        if (result.success) {
          people = [];
          agree = { privacy: false, portrait: false };
          step = 1;
          renderDone(result.data);
          window.scrollTo(0, 0);
          return;
        }

        if (result.error === "INVALID_PEOPLE" && result.errors) {
          result.errors.forEach(function (item) {
            var person = people[item.index];
            if (person) person.errors[item.field] = PERSON_ERRORS[item.error + "_" + item.field] || PERSON_ERRORS[item.error] || "請檢查此欄位";
          });
          step = 1;
          renderRegister();
          focusFirstError();
          return;
        }

        if (/^REG_/.test(result.error) || result.error === "UNIT_NOT_FOUND") {
          reload().then(function () {
            if (unit) { history.replaceState(null, "", base); renderIntro(); toast(ERRORS[result.error] || "目前無法報名"); }
          });
          return;
        }

        renderConsent(ERRORS[result.error] || "送出失敗，請稍後再試一次。");
      });
    }
  }

  /* ---------- Turnstile ---------- */
  function mountTurnstile() {
    var box = document.getElementById("turnstile-box");
    if (!box) return;
    turnstileToken = "";

    function draw() {
      if (turnstileWidget !== null) {
        try { window.turnstile.remove(turnstileWidget); } catch (e) { /* 舊的已不在畫面上 */ }
      }
      turnstileWidget = window.turnstile.render(box, {
        sitekey: unit.turnstile_site_key,
        language: "zh-tw",
        theme: "auto",
        callback: function (token) { turnstileToken = token; },
        "expired-callback": function () { turnstileToken = ""; },
        "error-callback": function () { turnstileToken = ""; }
      });
    }

    if (window.turnstile) { draw(); return; }
    window.onTurnstileLoad = draw;
    if (!document.getElementById("turnstile-script")) {
      document.head.appendChild(el("script", {
        id: "turnstile-script",
        src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad",
        async: true,
        defer: true
      }));
    }
  }

  /* ---------- 完成 ---------- */
  function renderDone(data) {
    document.title = "報名完成｜" + unit.event_title;
    var rejected = data.people.some(function (p) { return p.status === "rejected"; });
    var hasWait = data.people.some(function (p) { return p.status === "wait"; });

    render([
      appbar("報名完成", unit.event_title, null, null),
      el("main", { class: "form-wrap" }, [
        el("div", { class: "done-head" }, [
          el("div", { class: "done-icon" }, [icon("check", 34)]),
          el("h1", { text: rejected && !data.people.some(function (p) { return p.status !== "rejected"; }) ? "名額已滿" : "報名完成" }),
          el("p", { class: "hint", style: "margin:0;font-size:14px", text: data.event_title + (data.event_time ? "・" + data.event_time : "") })
        ]),
        el("section", { class: "card", style: "gap:0;padding-top:4px;padding-bottom:4px" }, data.people.map(function (p) {
          var chip = p.status === "main" ? "正取" : (p.status === "wait" ? "備取第 " + p.wait_no + " 位" : "未報名成功");
          return el("div", { class: "result-row" }, [
            el("div", { style: "min-width:0" }, [
              el("b", { text: p.title }),
              el("span", { class: "hint", text: [p.name_masked, p.phone_masked, p.email_masked].filter(Boolean).join("・") })
            ]),
            el("span", { class: "chip " + p.status, text: chip })
          ]);
        })),
        rejected ? el("div", { class: "alert", text: "名額已滿，標示「未報名成功」的報名者沒有完成報名，資料也不會保留。" }) : null,
        el("div", { class: "notice", text: (hasWait ? "備取者如有正取名額釋出，將由主辦單位聯繫遞補。\n" : "") + "建議截圖保存此頁。", style: "white-space:pre-line" }),
        el("button", { class: "btn ghost block", type: "button", onclick: function () { reload().then(function () { go(base); }); } }, ["回活動頁"]),
        footer()
      ])
    ]);
  }

  /* ---------- 路由 ---------- */
  function route() {
    if (!unit) return;
    if (/\/register\/?$/.test(location.pathname)) renderRegister();
    else renderIntro();
  }

  function go(path) {
    history.pushState(null, "", path);
    route();
    window.scrollTo(0, 0);
  }

  function reload() {
    return api("/api/public/units/" + code).then(function (result) {
      if (!result.success) {
        unit = null;
        if (result.error === "UNIT_NOT_FOUND") statePage("找不到這個活動", "請確認網址是否正確。");
        else statePage("暫時無法載入", "請檢查網路後重新整理頁面。");
        return;
      }

      var data = result.data;
      document.documentElement.style.setProperty("--accent", data.accent || "#0F6E6E");
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", data.accent || "#0F6E6E");

      if (data.state === "ended") {
        unit = null;
        footerConfig = data.footer;
        document.title = data.event_title + "｜" + data.name;
        statePage("活動已結束", data.name + "「" + data.event_title + "」已經結束，感謝參與。");
        return;
      }
      unit = data;
    });
  }

  window.addEventListener("popstate", function () { step = 1; route(); });

  if (!code) statePage("找不到這個活動", "請確認網址是否正確。");
  else reload().then(route);
})();
