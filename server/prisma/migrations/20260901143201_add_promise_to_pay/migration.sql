-- CreateEnum
CREATE TYPE "PromiseToPayStatus" AS ENUM ('ACTIVE', 'KEPT', 'BROKEN', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'PROMISE_TO_PAY_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'PROMISE_TO_PAY_UPDATED';

-- CreateTable
CREATE TABLE "PromiseToPay" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "promisedAmount" INTEGER NOT NULL,
    "promisedPaymentDate" TIMESTAMP(3) NOT NULL,
    "status" "PromiseToPayStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromiseToPay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromiseToPay_invoiceId_status_idx" ON "PromiseToPay"("invoiceId", "status");

-- AddForeignKey
ALTER TABLE "PromiseToPay" ADD CONSTRAINT "PromiseToPay_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
