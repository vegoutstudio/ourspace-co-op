-- OurSpace.Co-op 0001 建表（可重複執行）

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_sub TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  picture_url TEXT,
  is_sysadmin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  code_fails INTEGER NOT NULL DEFAULT 0,
  code_locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  event_title TEXT NOT NULL,
  event_time TEXT,
  location TEXT,
  intro TEXT,
  rules TEXT,
  prizes TEXT,
  notes TEXT,
  contact TEXT,
  accent TEXT NOT NULL DEFAULT '#0F6E6E',
  logo_image_id INTEGER,
  cover_image_id INTEGER,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  reg_open INTEGER NOT NULL DEFAULT 1,
  reg_deadline TEXT,
  capacity_main INTEGER NOT NULL DEFAULT 32,
  capacity_wait INTEGER NOT NULL DEFAULT 0,
  max_per_submit INTEGER NOT NULL DEFAULT 5,
  admin_code TEXT UNIQUE,
  staff_code TEXT UNIQUE,
  purged_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, unit_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_unit ON memberships(unit_id);

CREATE TABLE IF NOT EXISTS consent_texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('privacy', 'portrait')),
  body TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL,
  batch TEXT NOT NULL,
  name TEXT,
  nickname TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL CHECK (status IN ('main', 'wait', 'cancelled')),
  privacy_text_id INTEGER NOT NULL,
  portrait_text_id INTEGER NOT NULL,
  agreed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entries_unit ON entries(unit_id, status, id);

CREATE INDEX IF NOT EXISTS idx_entries_batch ON entries(batch);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entries_nickname
ON entries(unit_id, nickname COLLATE NOCASE) WHERE status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS uq_entries_phone
ON entries(unit_id, phone) WHERE status <> 'cancelled' AND phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  unit_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_unit ON audit_logs(unit_id, id);

INSERT INTO consent_texts (kind, body)
SELECT 'privacy', '【個人資料使用說明】
{單位} 與協辦單位窩室（以下合稱主辦單位）為辦理本活動報名、報到與聯繫，蒐集您的姓名、參賽暱稱與手機號碼。
1. 利用期間：自報名起至合作期間結束後 6 個月，期滿刪除姓名與手機號碼，僅保留參賽暱稱與比賽紀錄。
2. 利用範圍：僅用於本活動之聯繫與管理，不提供給其他第三人。
3. 您可依個人資料保護法向主辦單位請求查詢、更正或刪除您的資料；如不提供上述資料，將無法完成報名。'
WHERE NOT EXISTS (SELECT 1 FROM consent_texts WHERE kind = 'privacy');

INSERT INTO consent_texts (kind, body)
SELECT 'portrait', '【肖像權使用說明】
活動現場將進行拍照及錄影，所拍攝之照片與影片可能用於 {單位} 及窩室之活動紀錄、社群貼文與宣傳，不另行通知亦不另支付報酬。如有特定照片需下架，請聯絡主辦單位。'
WHERE NOT EXISTS (SELECT 1 FROM consent_texts WHERE kind = 'portrait');
