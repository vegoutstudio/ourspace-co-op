# OurSpace.Co-op

窩室協辦報名系統（多單位）。

- 前台：/u/單位代碼、/u/單位代碼/register
- 後台：/admin/（LINE 登入）
- 資料庫：D1 `ourspace-co-op-db`，依序執行 migrations/ 裡的 0001、0002、0003

Worker 密鑰（Settings → Variables and Secrets，類型選 Secret）：
LINE_CHANNEL_ID、LINE_CHANNEL_SECRET、TURNSTILE_SITE_KEY、TURNSTILE_SECRET、SETUP_CODE

更新用的 zip 不包含 wrangler.jsonc（裡面有各自的 Database ID），解壓不會覆蓋。
