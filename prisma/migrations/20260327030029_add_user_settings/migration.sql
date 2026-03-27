-- CreateTable
CREATE TABLE "UserSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "playDuration" INTEGER NOT NULL DEFAULT 30,
    "voiceId" TEXT NOT NULL DEFAULT '',
    "speed" REAL NOT NULL DEFAULT 1.0,
    "floatingPlayerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "themeMode" TEXT NOT NULL DEFAULT 'system',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");
