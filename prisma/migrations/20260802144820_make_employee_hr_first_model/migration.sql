-- Employee becomes an HR-first record: userId is now optional (portal login
-- is granted later via invitation), and email is the stable per-tenant
-- identifier a later login links back to.

-- Drop the old FK (ON DELETE CASCADE) so it can be redefined as SET NULL —
-- deleting the linked User should revoke portal access, not erase the HR
-- record, since the Employee is meant to exist independently of login.
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_userId_fkey";

-- AlterTable: userId nullable, add email (nullable for now) + invitedAt
ALTER TABLE "Employee"
  ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "invitedAt" TIMESTAMP(3);

-- Backfill email from the linked user for existing rows (every row created
-- before this migration has a userId, since portal-first was the only path).
UPDATE "Employee" e
SET "email" = u."email"
FROM "user" u
WHERE e."userId" = u."id";

-- Now that every existing row has an email, enforce it going forward.
ALTER TABLE "Employee" ALTER COLUMN "email" SET NOT NULL;

-- Re-add the FK with SET NULL instead of CASCADE.
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Email is unique per tenant, not globally.
CREATE UNIQUE INDEX "Employee_organizationId_email_key" ON "Employee"("organizationId", "email");
