-- CreateEnum
CREATE TYPE "RegularizationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RegularizationType" AS ENUM ('MISSING_PUNCH', 'WRONG_TIME', 'WFH', 'OTHER');

-- AlterEnum
ALTER TYPE "AttendanceSource" ADD VALUE 'REGULARIZED';

-- CreateTable
CREATE TABLE "RegularizationRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "RegularizationType" NOT NULL,
    "requestedCheckInAt" TIMESTAMP(3),
    "requestedCheckOutAt" TIMESTAMP(3),
    "requestedStatus" "AttendanceStatus",
    "reason" TEXT NOT NULL,
    "status" "RegularizationStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByEmployeeId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegularizationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegularizationRequest_organizationId_idx" ON "RegularizationRequest"("organizationId");

-- CreateIndex
CREATE INDEX "RegularizationRequest_employeeId_idx" ON "RegularizationRequest"("employeeId");

-- CreateIndex
CREATE INDEX "RegularizationRequest_status_idx" ON "RegularizationRequest"("status");

-- AddForeignKey
ALTER TABLE "RegularizationRequest" ADD CONSTRAINT "RegularizationRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegularizationRequest" ADD CONSTRAINT "RegularizationRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegularizationRequest" ADD CONSTRAINT "RegularizationRequest_decidedByEmployeeId_fkey" FOREIGN KEY ("decidedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: at most ONE PENDING request per (employee, date).
-- Prisma's @@unique can't express a WHERE clause, and a plain unique index
-- would wrongly block re-requesting a date after a rejection/cancellation.
-- Enforced in the database because the app-level pre-check races: two
-- concurrent submits can both read "no pending" before either inserts.
CREATE UNIQUE INDEX "RegularizationRequest_one_pending_per_employee_date"
  ON "RegularizationRequest"("employeeId", "date")
  WHERE status = 'PENDING';
