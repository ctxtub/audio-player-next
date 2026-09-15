-- M7-03 Sleep Timer Semantic Migration（spec §23/§23.1 + §29/§29.1/§29.2）
-- 只做 ADD COLUMN + UPDATE 回填，不动表结构（无 SQLite rebuild，与 M5-02 同策略）。
--
-- Step 1 — Config 默认睡眠定时（UserConfig + GuestConfig 对称）：
--   1a. defaultSleepTimerMinutes 逻辑 rename：物理列仍为 playDurationMinutes（@map），
--       无需 DDL，历史值原样保留；
--   1b. 新增 defaultSleepTimerEnabled（BOOLEAN NOT NULL DEFAULT true）：
--       已有用户升级后行为保持当前逻辑（默认仍 30 分钟，不会突然无限播放，§29.2）。
--
-- Step 2 — Anchor 睡眠定时三态（UserPlaybackProgress + GuestPlaybackProgress 对称）：
--   2a. 新增 sleepTimerMode（TEXT NOT NULL DEFAULT 'minutes'）；
--   2b. Legacy 回填（§23.1，不得只依赖列 default）：
--         remainingAllowedMs IS NOT NULL → 'minutes'
--         remainingAllowedMs IS NULL     → 'off'
--       幂等，可重跑；未知/非法既有值不做其它改写（fail-closed，由 reader 侧收敛）。

-- Step 1b — Config 默认开关（User + Guest；经 prisma migrate 单次执行）
ALTER TABLE "UserConfig" ADD COLUMN "defaultSleepTimerEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "GuestConfig" ADD COLUMN "defaultSleepTimerEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Step 2a — Anchor 三态列（User + Guest；经 prisma migrate 单次执行）
ALTER TABLE "UserPlaybackProgress" ADD COLUMN "sleepTimerMode" TEXT NOT NULL DEFAULT 'minutes';
ALTER TABLE "GuestPlaybackProgress" ADD COLUMN "sleepTimerMode" TEXT NOT NULL DEFAULT 'minutes';

-- Step 2b — Legacy 回填（§23.1；UPDATE 本身幂等，可重跑）
UPDATE "UserPlaybackProgress" SET "sleepTimerMode" = 'minutes' WHERE "remainingAllowedMs" IS NOT NULL;
UPDATE "UserPlaybackProgress" SET "sleepTimerMode" = 'off' WHERE "remainingAllowedMs" IS NULL;
UPDATE "GuestPlaybackProgress" SET "sleepTimerMode" = 'minutes' WHERE "remainingAllowedMs" IS NOT NULL;
UPDATE "GuestPlaybackProgress" SET "sleepTimerMode" = 'off' WHERE "remainingAllowedMs" IS NULL;
