-- CreateTable
CREATE TABLE "GuestChatMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guestId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "messageId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parts" TEXT,
    "agentType" TEXT,
    "createdAt" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GuestGenerationHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guestId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "storyText" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GuestPromptHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guestId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "lastUsed" DATETIME NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "GuestChatMessage_guestId_position_idx" ON "GuestChatMessage"("guestId", "position");

-- CreateIndex
CREATE INDEX "GuestChatMessage_guestId_idx" ON "GuestChatMessage"("guestId");

-- CreateIndex
CREATE INDEX "GuestChatMessage_updatedAt_idx" ON "GuestChatMessage"("updatedAt");

-- CreateIndex
CREATE INDEX "GuestGenerationHistory_guestId_createdAt_idx" ON "GuestGenerationHistory"("guestId", "createdAt");

-- CreateIndex
CREATE INDEX "GuestGenerationHistory_guestId_idx" ON "GuestGenerationHistory"("guestId");

-- CreateIndex
CREATE INDEX "GuestGenerationHistory_updatedAt_idx" ON "GuestGenerationHistory"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuestPromptHistory_guestId_prompt_key" ON "GuestPromptHistory"("guestId", "prompt");

-- CreateIndex
CREATE INDEX "GuestPromptHistory_guestId_lastUsed_idx" ON "GuestPromptHistory"("guestId", "lastUsed");

-- CreateIndex
CREATE INDEX "GuestPromptHistory_guestId_idx" ON "GuestPromptHistory"("guestId");

-- CreateIndex
CREATE INDEX "GuestPromptHistory_updatedAt_idx" ON "GuestPromptHistory"("updatedAt");
