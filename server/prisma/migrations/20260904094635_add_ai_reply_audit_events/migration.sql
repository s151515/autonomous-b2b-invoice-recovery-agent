-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'CUSTOMER_REPLY_RECEIVED';
ALTER TYPE "AuditEventType" ADD VALUE 'AI_REPLY_INTERPRETED';
ALTER TYPE "AuditEventType" ADD VALUE 'AUTOMATION_STOPPED';
