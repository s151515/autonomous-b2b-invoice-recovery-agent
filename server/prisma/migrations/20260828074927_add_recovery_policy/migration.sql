-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'POLICY_EVALUATION';

-- CreateTable
CREATE TABLE "RecoveryPolicy" (
    "id" TEXT NOT NULL,
    "merchantKey" TEXT NOT NULL,
    "maxExtensionDays" INTEGER NOT NULL DEFAULT 14,
    "maxDiscountPercent" INTEGER NOT NULL DEFAULT 2,
    "maxRemindersPerWeek" INTEGER NOT NULL DEFAULT 3,
    "humanEscalationThresholdDays" INTEGER NOT NULL DEFAULT 45,
    "requireHumanApprovalForDiscount" BOOLEAN NOT NULL DEFAULT true,
    "allowWhatsapp" BOOLEAN NOT NULL DEFAULT true,
    "allowEmail" BOOLEAN NOT NULL DEFAULT true,
    "allowVoice" BOOLEAN NOT NULL DEFAULT false,
    "stopOnOptOut" BOOLEAN NOT NULL DEFAULT true,
    "stopOnDispute" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryPolicy_merchantKey_key" ON "RecoveryPolicy"("merchantKey");
