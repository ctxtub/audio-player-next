-- CreateTable
CREATE TABLE "UserConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "playDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "voiceId" TEXT NOT NULL DEFAULT '',
    "speed" REAL NOT NULL DEFAULT 1.0,
    "floatingPlayerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "themeMode" TEXT NOT NULL DEFAULT 'system',
    "extras" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserConfig_userId_key" ON "UserConfig"("userId");
