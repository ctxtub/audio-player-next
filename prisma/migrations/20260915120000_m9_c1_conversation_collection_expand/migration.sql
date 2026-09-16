-- M9-C1 Conversation / StoryCollection expand migration（change-id 2026-09-15-story-collection-continuous-creation T1）
-- 策略（expand-only，无 contract）：
-- - 只新增表 Conversation / StoryCollection（User）与 GuestConversation / GuestStoryCollection（Guest 对称）；
-- - 既有表只 ADD COLUMN（ChatMessage/GuestChatMessage + conversationId；GenerationHistory/GuestGenerationHistory
--   + collectionId/position），不删除、不改写任何历史列或历史行；旧读路径与旧表保持可用（回退 read flag 依赖此点）；
-- - 零历史回填：本 migration 只建结构；数据由可重复 backfill 服务另行处理（一 Work 一 Collection，禁止按时间猜测合并）；
-- - 新增 FK 全部 nullable（历史行 NULL），唯一索引在 NULL 上不冲突，因而无需 SQLite rebuild；
-- - 一主体至多一个 active Conversation 由服务事务 + 部分唯一索引双保险。

-- 1. User 侧 Conversation
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Conversation_userId_state_idx" ON "Conversation"("userId", "state");
CREATE INDEX "Conversation_updatedAt_idx" ON "Conversation"("updatedAt");
-- 部分唯一索引：每主体至多一个 active（并发 createNew 的数据库级兜底；Prisma schema 不表达 partial index）
CREATE UNIQUE INDEX "Conversation_userId_active_key" ON "Conversation"("userId") WHERE "state" = 'active';

-- 2. User 侧 StoryCollection（conversationId 唯一：一会话一作品集）
CREATE TABLE "StoryCollection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "conversationId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "titleSource" TEXT NOT NULL DEFAULT 'fallback',
    "favoritedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryCollection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StoryCollection_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StoryCollection_conversationId_key" ON "StoryCollection"("conversationId");
CREATE INDEX "StoryCollection_userId_deletedAt_idx" ON "StoryCollection"("userId", "deletedAt");
CREATE INDEX "StoryCollection_userId_favoritedAt_idx" ON "StoryCollection"("userId", "favoritedAt");
CREATE INDEX "StoryCollection_userId_createdAt_id_idx" ON "StoryCollection"("userId", "createdAt", "id");
CREATE INDEX "StoryCollection_updatedAt_idx" ON "StoryCollection"("updatedAt");

-- 3. Guest 侧 Conversation（guestId + updatedAt GC 索引）
CREATE TABLE "GuestConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guestId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "GuestConversation_guestId_state_idx" ON "GuestConversation"("guestId", "state");
CREATE INDEX "GuestConversation_guestId_idx" ON "GuestConversation"("guestId");
CREATE INDEX "GuestConversation_updatedAt_idx" ON "GuestConversation"("updatedAt");
CREATE UNIQUE INDEX "GuestConversation_guestId_active_key" ON "GuestConversation"("guestId") WHERE "state" = 'active';

-- 4. Guest 侧 StoryCollection（与 User 对称）
CREATE TABLE "GuestStoryCollection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guestId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "titleSource" TEXT NOT NULL DEFAULT 'fallback',
    "favoritedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuestStoryCollection_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "GuestConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GuestStoryCollection_conversationId_key" ON "GuestStoryCollection"("conversationId");
CREATE INDEX "GuestStoryCollection_guestId_deletedAt_idx" ON "GuestStoryCollection"("guestId", "deletedAt");
CREATE INDEX "GuestStoryCollection_guestId_favoritedAt_idx" ON "GuestStoryCollection"("guestId", "favoritedAt");
CREATE INDEX "GuestStoryCollection_guestId_createdAt_id_idx" ON "GuestStoryCollection"("guestId", "createdAt", "id");
CREATE INDEX "GuestStoryCollection_guestId_idx" ON "GuestStoryCollection"("guestId");
CREATE INDEX "GuestStoryCollection_updatedAt_idx" ON "GuestStoryCollection"("updatedAt");

-- 5. ChatMessage + conversationId（nullable FK，历史行 NULL）
ALTER TABLE "ChatMessage" ADD COLUMN "conversationId" TEXT REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ChatMessage_conversationId_position_key" ON "ChatMessage"("conversationId", "position");
CREATE UNIQUE INDEX "ChatMessage_conversationId_messageId_key" ON "ChatMessage"("conversationId", "messageId");
CREATE INDEX "ChatMessage_conversationId_position_idx" ON "ChatMessage"("conversationId", "position");

-- 6. GuestChatMessage + conversationId
ALTER TABLE "GuestChatMessage" ADD COLUMN "conversationId" TEXT REFERENCES "GuestConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "GuestChatMessage_conversationId_position_key" ON "GuestChatMessage"("conversationId", "position");
CREATE UNIQUE INDEX "GuestChatMessage_conversationId_messageId_key" ON "GuestChatMessage"("conversationId", "messageId");
CREATE INDEX "GuestChatMessage_conversationId_position_idx" ON "GuestChatMessage"("conversationId", "position");

-- 7. GenerationHistory (StoryWork) + collectionId / position
ALTER TABLE "GenerationHistory" ADD COLUMN "collectionId" TEXT REFERENCES "StoryCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GenerationHistory" ADD COLUMN "position" INTEGER;
CREATE UNIQUE INDEX "GenerationHistory_collectionId_position_key" ON "GenerationHistory"("collectionId", "position");
CREATE UNIQUE INDEX "GenerationHistory_collectionId_sourceMessageId_key" ON "GenerationHistory"("collectionId", "sourceMessageId");
CREATE INDEX "GenerationHistory_collectionId_position_idx" ON "GenerationHistory"("collectionId", "position");

-- 8. GuestGenerationHistory (GuestStoryWork) + collectionId / position
ALTER TABLE "GuestGenerationHistory" ADD COLUMN "collectionId" TEXT REFERENCES "GuestStoryCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestGenerationHistory" ADD COLUMN "position" INTEGER;
CREATE UNIQUE INDEX "GuestGenerationHistory_collectionId_position_key" ON "GuestGenerationHistory"("collectionId", "position");
CREATE UNIQUE INDEX "GuestGenerationHistory_collectionId_sourceMessageId_key" ON "GuestGenerationHistory"("collectionId", "sourceMessageId");
CREATE INDEX "GuestGenerationHistory_collectionId_position_idx" ON "GuestGenerationHistory"("collectionId", "position");
