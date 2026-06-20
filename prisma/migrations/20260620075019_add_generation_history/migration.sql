-- CreateTable
CREATE TABLE "GenerationHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "storyText" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GenerationHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GenerationHistory_userId_createdAt_idx" ON "GenerationHistory"("userId", "createdAt");
