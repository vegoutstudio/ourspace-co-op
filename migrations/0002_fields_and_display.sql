-- OurSpace.Co-op 0002：Email 欄位、欄位必填設定、頁首／頁尾顯示設定、備取無上限
-- 只能執行一次（重複執行會出現 duplicate column 錯誤，不影響資料）

ALTER TABLE units ADD COLUMN nickname_required INTEGER NOT NULL DEFAULT 1;
ALTER TABLE units ADD COLUMN phone_required INTEGER NOT NULL DEFAULT 1;
ALTER TABLE units ADD COLUMN email_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE units ADD COLUMN host_show INTEGER NOT NULL DEFAULT 1;
ALTER TABLE units ADD COLUMN host_label TEXT NOT NULL DEFAULT '協辦';
ALTER TABLE units ADD COLUMN host_name TEXT NOT NULL DEFAULT '窩室 OurSpace';
ALTER TABLE units ADD COLUMN footer_show INTEGER NOT NULL DEFAULT 1;
ALTER TABLE units ADD COLUMN footer_text TEXT NOT NULL DEFAULT '本報名系統由 窩室 OurSpace 提供';

ALTER TABLE entries ADD COLUMN email TEXT;

-- 暱稱改為可選填：空白暱稱不參與重複檢查
DROP INDEX IF EXISTS uq_entries_nickname;
CREATE UNIQUE INDEX IF NOT EXISTS uq_entries_nickname
ON entries(unit_id, nickname COLLATE NOCASE) WHERE status <> 'cancelled' AND nickname <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_entries_email
ON entries(unit_id, email COLLATE NOCASE) WHERE status <> 'cancelled' AND email IS NOT NULL;

-- 備取名額 -1 代表無上限
