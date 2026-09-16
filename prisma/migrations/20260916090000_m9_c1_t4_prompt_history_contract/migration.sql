-- M9-C1 T4 用户 PromptHistory contract 删除（技术方案 §7 步骤 5/7）
-- 合同依据：
-- - T2 已停止一切 user PromptHistory 新写（history-stop-migrate 锁定 0 行）且零读取；
-- - 本次仅删除用户侧 PromptHistory 物理表；以下一律保留：
--   GuestPromptHistory（lib/server/guestGc.ts 到期清理依赖，不得动该文件）；
--   StoryWorkMigration（T2 风险转移表）；
--   GenerationHistory / GuestGenerationHistory（作品物理表，零作品删除）；
--   StoryAudioManifest / StoryAudioSegment（T3 观察期保留）；
-- - 生产执行与物理删除需另行授权；本迁移仅生成 + 隔离库验证。
DROP TABLE "PromptHistory";
