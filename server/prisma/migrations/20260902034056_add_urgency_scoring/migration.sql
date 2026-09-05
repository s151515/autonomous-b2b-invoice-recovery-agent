-- CreateEnum
CREATE TYPE "UrgencyBand" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'URGENCY_SCORED';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "urgencyBand" "UrgencyBand" NOT NULL DEFAULT 'LOW',
ADD COLUMN     "urgencyScore" INTEGER NOT NULL DEFAULT 0;
