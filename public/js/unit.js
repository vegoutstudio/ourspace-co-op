/* =========================================================
   OurSpace.Co-op 前台：/u/代碼（活動介紹）、/u/代碼/register（報名）
========================================================= */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var match = location.pathname.match(/^\/u\/([A-Za-z0-9]{3,12})/);
  var code = match ? match[1].toLowerCase() : "";
  var base = "/u/" + code;
  var unit = null;
  var people = [];
  var turnstileToken = "";
  var turnstileWidget = null;
  var agree = { privacy: false, portrait: false };

  var FIELD_LABELS = { name: "姓名", nickname: "參賽暱稱", phone: "手機號碼", email: "Email" };
  var footerConfig = null;

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
    ALREADY_REGISTERED: "有報名者的暱稱或手機剛剛被使用了，請檢查後再送出。",
    TOO_MANY_PEOPLE: "一次報名的人數超過上限。",
    UNIT_NOT_FOUND: "找不到這個活動。"
  };

  /* ---------- DOM 工具 ---------- */
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

  function svgIcon(path, size, color) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", color);
    svg.setAttribute("stroke-width", "2.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("d", path);
    svg.appendChild(p);
    return svg;
  }

  function render(nodes) {
    app.textContent = "";
    nodes.forEach(function (n) { if (n) app.appendChild(n); });
    window.scrollTo(0, 0);
  }

  function formatTime(text) {
    if (!text) return "";
    var d = new Date(text.replace(" ", "T") + ":00");
    if (isNaN(d.getTime())) return text;
    var week = "日一二三四五六".charAt(d.getDay());
    return text.slice(0, 10).replace(/-/g, "/") + "（" + week + "）" + text.slice(11, 16);
  }

  function api(path, options) {
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return { success: false, error: "NETWORK" }; });
    }).catch(function () {
      return { success: false, error: "NETWORK" };
    });
  }

  /* ---------- 共用區塊 ---------- */
  function topBar(withBack) {
    var logo = unit.logo_url
      ? el("img", { class: "top-logo", src: unit.logo_url, alt: "" })
      : el("div", { class: "top-logo", "aria-hidden": "true", text: Array.from(unit.name || "?")[0] });

    return el("header", { class: "top" }, [
      withBack ? el("button", { class: "back", type: "button", "aria-label": "返回活動介紹", onclick: function () { go(base); } }, [svgIcon("M15 18l-6-6 6-6", 22, "currentColor")]) : null,
      withBack ? null : logo,
      el("div", null, [
        el("div", { class: "top-name", text: withBack ? "報名" : unit.name }),
        withBack
          ? el("div", { class: "top-sub", text: unit.event_title })
          : (unit.host && unit.host.show ? el("div", { class: "top-sub", text: unit.host.label + "：" + unit.host.name }) : null)
      ])
    ]);
  }

  function footer() {
    var config = unit ? unit.footer : footerConfig;
    if (!config || !config.show || !config.text) return null;
    return el("footer", { class: "foot", text: config.text });
  }

  function statePage(title, message) {
    render([
      el("main", { class: "state-page" }, [
        el("h1", { text: title }),
        message ? el("p", { class: "hint", text: message }) : null
      ]),
      footer()
    ]);
  }

  var REG_TEXT = {
    open: "報名中",
    closed: "未開放報名",
    deadline: "報名已截止",
    full: "名額已滿"
  };

  /* ---------- 活動介紹 ---------- */
  function renderIntro() {
    document.title = unit.event_title + "｜" + unit.name;

    var open = unit.reg_state === "open";

    function section(title, body) {
      if (!body) return null;
      return el("div", { style: "display:flex;flex-direction:column;gap:6px" }, [
        el("h3", { text: title }),
        el("div", { class: "text", text: body })
      ]);
    }

    var hasIntro = unit.intro || unit.rules || unit.prizes || unit.notes;

    render([
      topBar(false),
      unit.cover_url ? el("img", { class: "cover", src: unit.cover_url, alt: "" }) : null,
      el("main", { class: "content" }, [
        el("div", { class: "head" }, [
          el("span", { class: "badge" + (open ? "" : " off"), text: REG_TEXT[unit.reg_state] }),
          el("h1", { text: unit.event_title })
        ]),
        (unit.event_time || unit.location || unit.reg_deadline) ? el("section", { class: "card" }, [
          el("dl", { class: "info", style: "margin:0" }, [
            unit.event_time ? el("dt", { text: "日期" }) : null,
            unit.event_time ? el("dd", { text: unit.event_time }) : null,
            unit.location ? el("dt", { text: "地點" }) : null,
            unit.location ? el("dd", { text: unit.location }) : null,
            unit.reg_deadline ? el("dt", { text: "報名截止" }) : null,
            unit.reg_deadline ? el("dd", { text: formatTime(unit.reg_deadline) }) : null
          ])
        ]) : null,
        hasIntro ? el("section", { class: "card" }, [
          el("h2", { text: "活動介紹" }),
          unit.intro ? el("div", { class: "text", text: unit.intro }) : null,
          section("賽制", unit.rules),
          section("獎品", unit.prizes),
          section("注意事項", unit.notes)
        ]) : null,
        unit.contact ? el("section", { class: "card" }, [
          el("h2", { text: "主辦單位聯絡方式" }),
          el("div", { class: "text", text: unit.contact })
        ]) : null,
        el("button", {
          class: "btn", type: "button", disabled: !open,
          onclick: function () { go(base + "/register"); }
        }, [open ? "我要報名" : REG_TEXT[unit.reg_state]])
      ]),
      footer()
    ]);
  }

  /* ---------- 報名表 ---------- */
  function newPerson() { return { name: "", nickname: "", phone: "", email: "", errors: {} }; }

  function isRequired(key) {
    return key === "name" || !!(unit.fields && unit.fields[key]);
  }

  function renderRegister(generalError) {
    if (unit.reg_state !== "open") { renderIntro(); return; }
    document.title = "報名｜" + unit.event_title;
    if (!people.length) people.push(newPerson());

    var noticeText = unit.main_full
      ? "正取已額滿，現在報名將列入備取。"
      : (unit.has_wait ? "名額有限，正取額滿後將列入備取。" : "名額有限，額滿為止。");

    var cards = people.map(function (person, index) {
      function field(key, type, extra) {
        var id = "f-" + key + "-" + index;
        var error = person.errors[key];
        var input = el("input", Object.assign({
          id: id, type: type, value: person[key],
          "aria-invalid": error ? "true" : null,
          "aria-describedby": error ? id + "-err" : null,
          oninput: function (event) { person[key] = event.target.value; }
        }, extra || {}));
        return el("div", { class: "field" }, [
          el("label", { for: id }, isRequired(key)
            ? [FIELD_LABELS[key] + " ", el("span", { class: "req", "aria-hidden": "true", text: "*" })]
            : [FIELD_LABELS[key] + " ", el("span", { class: "hint", text: "（選填）" })]),
          input,
          key === "nickname" ? el("div", { class: "hint", text: isRequired("nickname") ? "會顯示在比賽名單、對戰表" : "會顯示在比賽名單、對戰表；沒填會以遮蔽後的姓名顯示" }) : null,
          error ? el("div", { class: "field-error", id: id + "-err", text: error }) : null
        ]);
      }

      return el("section", { class: "card" }, [
        el("div", { class: "person-head" }, [
          el("h2", { text: "報名者 " + (index + 1) }),
          people.length > 1 ? el("button", {
            class: "btn ghost small", type: "button",
            onclick: function () { people.splice(index, 1); renderRegister(); }
          }, ["移除"]) : null
        ]),
        field("name", "text", { autocomplete: index === 0 ? "name" : "off", maxlength: "30" }),
        field("nickname", "text", { autocomplete: "off", maxlength: "20" }),
        field("phone", "tel", { autocomplete: index === 0 ? "tel" : "off", inputmode: "numeric", maxlength: "12", placeholder: "09xxxxxxxx" }),
        field("email", "email", { autocomplete: index === 0 ? "email" : "off", inputmode: "email", maxlength: "100", autocapitalize: "none", placeholder: "name@example.com" })
      ]);
    });

    var maxPeople = unit.max_per_submit;

    var privacyBox = el("input", { type: "checkbox", id: "agree-privacy", checked: agree.privacy, onchange: function (e) { agree.privacy = e.target.checked; } });
    var portraitBox = el("input", { type: "checkbox", id: "agree-portrait", checked: agree.portrait, onchange: function (e) { agree.portrait = e.target.checked; } });
    var submit = el("button", { class: "btn", type: "button", onclick: submitForm }, ["送出報名（" + people.length + " 人）"]);

    render([
      topBar(true),
      el("main", { class: "content" }, [
        el("div", { class: "notice" }, [
          noticeText,
          unit.reg_deadline ? el("br") : null,
          unit.reg_deadline ? "報名截止：" + formatTime(unit.reg_deadline) : null
        ]),
        el("div", { style: "display:flex;flex-direction:column;gap:16px" }, cards),
        people.length < maxPeople ? el("button", {
          class: "btn dashed", type: "button",
          onclick: function () { people.push(newPerson()); renderRegister(); }
        }, ["＋ 新增一位報名者"]) : el("p", { class: "center-note", style: "margin:0", text: "一次最多報名 " + maxPeople + " 人" }),
        el("section", { class: "card" }, [
          el("h2", { text: "個資與肖像權" }),
          el("div", { class: "consent-text", tabindex: "0", text: unit.consents.privacy ? unit.consents.privacy.body : "" }),
          el("label", { class: "check", for: "agree-privacy" }, [privacyBox, el("span", null, ["我已閱讀並同意個資使用說明 ", el("span", { class: "req", text: "*" })])]),
          el("div", { class: "consent-text", tabindex: "0", text: unit.consents.portrait ? unit.consents.portrait.body : "" }),
          el("label", { class: "check", for: "agree-portrait" }, [portraitBox, el("span", null, ["我同意肖像權使用說明 ", el("span", { class: "req", text: "*" })])]),
          people.length > 1 ? el("p", { class: "hint", style: "margin:0", text: "多人報名時，由送出者代表所有報名者同意，請先取得同行者同意。" }) : null
        ]),
        unit.turnstile_site_key
          ? el("div", { id: "turnstile-box", style: "min-height:66px" })
          : el("div", { class: "alert", text: "報名驗證尚未設定，請聯絡主辦單位。" }),
        generalError ? el("div", { class: "alert", role: "alert", id: "general-error", text: generalError }) : null,
        submit,
        el("p", { class: "center-note", style: "margin:0", text: "送出後無法自行修改，如需取消請聯絡主辦單位。" })
      ]),
      footer()
    ]);

    if (!unit.turnstile_site_key) submit.disabled = true;
    mountTurnstile();

    if (generalError) {
      var box = document.getElementById("general-error");
      if (box) box.scrollIntoView({ block: "center" });
    }

    function submitForm() {
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

      if (hasError) { renderRegister(); focusFirstError(); return; }
      if (!agree.privacy || !agree.portrait) { renderRegister(ERRORS.CONSENT_REQUIRED); return; }
      if (!turnstileToken) { renderRegister("請先完成下方的驗證。"); return; }

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
          renderDone(result.data);
          return;
        }

        if (result.error === "INVALID_PEOPLE" && result.errors) {
          result.errors.forEach(function (item) {
            var person = people[item.index];
            if (!person) return;
            person.errors[item.field] = PERSON_ERRORS[item.error + "_" + item.field] || PERSON_ERRORS[item.error] || "請檢查此欄位";
          });
          renderRegister();
          focusFirstError();
          return;
        }

        if (/^REG_/.test(result.error) || result.error === "UNIT_NOT_FOUND") {
          reload().then(function () {
            if (unit) renderIntro();
          });
          return;
        }

        renderRegister(ERRORS[result.error] || "送出失敗，請稍後再試一次。");
      });
    }
  }

  function focusFirstError() {
    var first = document.querySelector('[aria-invalid="true"]');
    if (first) { first.scrollIntoView({ block: "center" }); first.focus({ preventScroll: true }); }
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
      el("main", { class: "content" }, [
        el("div", { class: "done-head" }, [
          el("div", { class: "done-icon" }, [svgIcon("M5 12l5 5L19 7", 32, "#FFFFFF")]),
          el("h1", { text: "報名完成" }),
          el("p", { class: "hint", style: "margin:0;font-size:14px", text: data.event_title + (data.event_time ? "・" + data.event_time : "") })
        ]),
        el("section", { class: "card", style: "gap:0;padding:4px 16px" }, data.people.map(function (p) {
          var chip = p.status === "main" ? "正取" : (p.status === "wait" ? "備取第 " + p.wait_no + " 位" : "未報名成功");
          var contact = [p.name_masked, p.phone_masked, p.email_masked].filter(Boolean).join("・");
          return el("div", { class: "result-row" }, [
            el("div", { style: "min-width:0" }, [
              el("div", { style: "font-weight:700;overflow-wrap:anywhere", text: p.title }),
              el("div", { class: "hint", style: "overflow-wrap:anywhere", text: contact })
            ]),
            el("span", { class: "chip " + p.status, text: chip })
          ]);
        })),
        rejected ? el("div", { class: "alert", text: "名額已滿，標示「未報名成功」的報名者沒有完成報名，資料也不會保留。" }) : null,
        el("div", { class: "card text", style: "font-size:13px", text: (hasWait ? "備取者如有正取名額釋出，將由主辦單位聯繫遞補。\n" : "") + "建議截圖保存此頁。" }),
        el("button", {
          class: "btn ghost", type: "button",
          onclick: function () { reload().then(function () { go(base); }); }
        }, ["回活動頁"])
      ]),
      footer()
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

  window.addEventListener("popstate", route);

  if (!code) {
    statePage("找不到這個活動", "請確認網址是否正確。");
  } else {
    reload().then(route);
  }
})();
