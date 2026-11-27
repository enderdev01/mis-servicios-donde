-- Adds the terminal 'failed' status to AlertIntent: SQLite cannot alter a CHECK constraint, so the table is rebuilt.
-- Nothing references AlertIntent, so the rebuild needs no foreign-key handling.
CREATE TABLE "AlertIntent_new" (
  "id" TEXT PRIMARY KEY,
  "episodeId" TEXT NOT NULL REFERENCES "OutageEpisode"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" = 'OPENED'),
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'delivered', 'retryable', 'cancelled', 'failed')),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "leaseToken" TEXT,
  "leaseExpiresAt" TEXT,
  "deliveredAt" TEXT,
  "cancelledAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("episodeId", "kind")
);

INSERT INTO "AlertIntent_new" SELECT "id", "episodeId", "kind", "content", "status", "attempts", "nextAttemptAt", "leaseToken", "leaseExpiresAt", "deliveredAt", "cancelledAt", "createdAt" FROM "AlertIntent";

DROP TABLE "AlertIntent";
ALTER TABLE "AlertIntent_new" RENAME TO "AlertIntent";

CREATE INDEX "AlertIntent_dispatch_idx" ON "AlertIntent" ("status", "nextAttemptAt");
