# OurSpace.Co-op

窩室協辦報名系統（多單位）。

- 前台：/u/單位代碼、/u/單位代碼/register
- 後台：/admin/（LINE 登入）
- 資料庫：D1 `ourspace-co-op-db`，依序執行 migrations/0001_init.sql、0002_fields_and_display.sql

Worker 密鑰（Settings → Variables and Secrets，類型選 Secret）：
LINE_CHANNEL_ID、LINE_CHANNEL_SECRET、TURNSTILE_SITE_KEY、TURNSTILE_SECRET、SETUP_CODE
