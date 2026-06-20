-- CreateTable
CREATE TABLE "PromptHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "lastUsed" DATETIME NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "PromptHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PromptHistory_userId_prompt_key" ON "PromptHistory"("userId", "prompt");
