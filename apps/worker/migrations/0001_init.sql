-- Final schema state of the 8 Postgres migrations in apps/api/prisma/migrations, as SQLite for D1.
-- Type mapping: uuid -> TEXT, timestamptz -> TEXT (ISO-8601 UTC), boolean -> INTEGER 0/1,
-- jsonb -> TEXT (json_valid), Postgres enums -> TEXT + CHECK.
-- gen_random_uuid() defaults are dropped on purpose: the app generates ids with crypto.randomUUID().

CREATE TABLE "PilotZone" (
  "id" TEXT PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "approved" INTEGER NOT NULL DEFAULT 0 CHECK ("approved" IN (0, 1)),
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "boundary" TEXT NOT NULL CHECK (json_valid("boundary"))
);

CREATE TABLE "SubmissionRecord" (
  "id" TEXT PRIMARY KEY,
  "deviceToken" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "trustDecision" TEXT NOT NULL CHECK ("trustDecision" IN ('eligible', 'excluded')),
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "expiresAt" TEXT NOT NULL,
  UNIQUE ("deviceToken", "submissionId")
);

CREATE TABLE "ReportEvent" (
  "id" TEXT PRIMARY KEY,
  "submissionId" TEXT NOT NULL REFERENCES "SubmissionRecord"("id") ON DELETE CASCADE,
  "h3Cell" TEXT NOT NULL,
  "service" TEXT NOT NULL CHECK ("service" IN ('water', 'electricity', 'internet')),
  "status" TEXT NOT NULL CHECK ("status" IN ('outage', 'restored')),
  "deviceToken" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "expiresAt" TEXT NOT NULL,
  "provider" TEXT NOT NULL CHECK ("provider" IN (
    'sedapal', 'luz_del_sur', 'pluz', 'movistar', 'claro', 'win', 'wow', 'mifibra', 'other'
  ))
);

CREATE TABLE "ReportDisplayName" (
  "reportEventId" TEXT PRIMARY KEY REFERENCES "ReportEvent"("id") ON DELETE CASCADE,
  "value" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL
);

CREATE TABLE "AbuseRecord" (
  "id" TEXT PRIMARY KEY,
  "deviceToken" TEXT NOT NULL,
  "decision" TEXT NOT NULL CHECK ("decision" IN ('eligible', 'excluded')),
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "expiresAt" TEXT NOT NULL
);

CREATE TABLE "OutageEpisode" (
  "id" TEXT PRIMARY KEY,
  "zoneId" TEXT NOT NULL REFERENCES "PilotZone"("id"),
  "h3Cell" TEXT NOT NULL,
  "service" TEXT NOT NULL CHECK ("service" IN ('water', 'electricity', 'internet')),
  "active" INTEGER NOT NULL DEFAULT 1 CHECK ("active" IN (0, 1)),
  "expiresAt" TEXT NOT NULL,
  "openedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "lastQuorumAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "closedAt" TEXT,
  "closureReason" TEXT CHECK ("closureReason" IN ('restored', 'expired')),
  "provider" TEXT NOT NULL CHECK ("provider" IN (
    'sedapal', 'luz_del_sur', 'pluz', 'movistar', 'claro', 'win', 'wow', 'mifibra', 'other'
  ))
);

CREATE TABLE "AlertIntent" (
  "id" TEXT PRIMARY KEY,
  "episodeId" TEXT NOT NULL REFERENCES "OutageEpisode"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" = 'OPENED'),
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'delivered', 'retryable', 'cancelled')),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "leaseToken" TEXT,
  "leaseExpiresAt" TEXT,
  "deliveredAt" TEXT,
  "cancelledAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("episodeId", "kind")
);

CREATE INDEX "SubmissionRecord_deviceToken_createdAt_idx" ON "SubmissionRecord" ("deviceToken", "createdAt");
CREATE INDEX "SubmissionRecord_expiresAt_idx" ON "SubmissionRecord" ("expiresAt");
CREATE INDEX "ReportEvent_h3Cell_service_provider_status_createdAt_idx"
  ON "ReportEvent" ("h3Cell", "service", "provider", "status", "createdAt");
CREATE INDEX "ReportEvent_expiresAt_idx" ON "ReportEvent" ("expiresAt");
CREATE INDEX "ReportDisplayName_expiresAt_idx" ON "ReportDisplayName" ("expiresAt");
CREATE INDEX "AbuseRecord_deviceToken_createdAt_idx" ON "AbuseRecord" ("deviceToken", "createdAt");
CREATE INDEX "AbuseRecord_expiresAt_idx" ON "AbuseRecord" ("expiresAt");
CREATE INDEX "OutageEpisode_h3Cell_service_provider_active_expiresAt_idx"
  ON "OutageEpisode" ("h3Cell", "service", "provider", "active", "expiresAt");
-- Replaces the Postgres advisory locks: at most one active episode per cell, service and provider.
CREATE UNIQUE INDEX "OutageEpisode_active_unique"
  ON "OutageEpisode" ("h3Cell", "service", "provider") WHERE "active" = 1;
CREATE INDEX "AlertIntent_dispatch_idx" ON "AlertIntent" ("status", "nextAttemptAt");

-- Same as Postgres: ReportEvent rows may be inserted and deleted (retention, cascades) but never updated.
CREATE TRIGGER prevent_report_event_mutation
  BEFORE UPDATE ON "ReportEvent"
  FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ReportEvent records are immutable');
END;
