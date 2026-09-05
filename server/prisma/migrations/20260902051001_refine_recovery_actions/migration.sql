/*
  Warnings:

  - The values [SEND_WHATSAPP_REMINDER] on the enum `RecoveryAction` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "RecoveryAction_new" AS ENUM ('MONITOR_INVOICE', 'SEND_EMAIL_REMINDER', 'SEND_EMAIL_AND_WHATSAPP_REMINDER', 'SEND_PAYMENT_LINK', 'WAIT_FOR_PROMISED_PAYMENT', 'SEND_PROMISE_REMINDER', 'HUMAN_REVIEW_REQUIRED');
ALTER TABLE "Invoice" ALTER COLUMN "recommendedAction" DROP DEFAULT;
ALTER TABLE "Invoice" ALTER COLUMN "recommendedAction" TYPE "RecoveryAction_new" USING ("recommendedAction"::text::"RecoveryAction_new");
ALTER TYPE "RecoveryAction" RENAME TO "RecoveryAction_old";
ALTER TYPE "RecoveryAction_new" RENAME TO "RecoveryAction";
DROP TYPE "RecoveryAction_old";
ALTER TABLE "Invoice" ALTER COLUMN "recommendedAction" SET DEFAULT 'MONITOR_INVOICE';
COMMIT;
