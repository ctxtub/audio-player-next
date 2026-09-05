-- CreateTable
CREATE TABLE "GuestConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guestId" TEXT NOT NULL,
    "playDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "voiceId" TEXT NOT NULL DEFAULT '',
    "speed" REAL NOT NULL DEFAULT 1.0,
    "floatingPlayerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "themeMode" TEXT NOT NULL DEFAULT 'system',
    "extras" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestConfig_guestId_key" ON "GuestConfig"("guestId");

-- CreateIndex
CREATE INDEX "GuestConfig_guestId_idx" ON "GuestConfig"("guestId");

-- CreateIndex
CREATE INDEX "GuestConfig_updatedAt_idx" ON "GuestConfig"("updatedAt");
