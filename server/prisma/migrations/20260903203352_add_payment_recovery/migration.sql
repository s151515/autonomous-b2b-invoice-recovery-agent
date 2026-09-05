/*
  Warnings:

  - A unique constraint covering the columns `[razorpayPaymentId]` on the table `PaymentLink` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'PAYMENT_CONFIRMED';
ALTER TYPE "AuditEventType" ADD VALUE 'INVOICE_RECOVERED';
ALTER TYPE "AuditEventType" ADD VALUE 'WEBHOOK_REJECTED';

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'RECOVERED';

-- AlterTable
ALTER TABLE "PaymentLink" ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "razorpayPaymentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_razorpayPaymentId_key" ON "PaymentLink"("razorpayPaymentId");
