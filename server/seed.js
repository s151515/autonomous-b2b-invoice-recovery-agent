require("dotenv").config();

const {
  PrismaClient,
  InvoiceStatus,
  AuditEventType,
} = require("@prisma/client");

const prisma = new PrismaClient();

const merchantKey = "merchant_demo_01";

const invoices = [
  {
    invoiceNumber: "INV-2026-0042",
    customer: "Acme Components Pvt Ltd",
    amount: 85000,
    daysOverdue: 21,
    status: InvoiceStatus.HIGH_PRIORITY,
  },
  {
    invoiceNumber: "INV-2026-0039",
    customer: "Nova Industrial Supplies",
    amount: 125000,
    daysOverdue: 12,
    status: InvoiceStatus.FOLLOW_UP_DUE,
  },
  {
    invoiceNumber: "INV-2026-0031",
    customer: "Orbit Manufacturing Ltd",
    amount: 45000,
    daysOverdue: 6,
    status: InvoiceStatus.PROMISE_TO_PAY,
  },
    {
    invoiceNumber: "INV-2026-0050",
    customer: "Vertex Engineering Pvt Ltd",
    amount: 20000,
    daysOverdue: 38,
    status: InvoiceStatus.HIGH_PRIORITY,
  },
  {
    invoiceNumber: "INV-2026-0051",
    customer: "BluePeak Logistics Ltd",
    amount: 15000,
    daysOverdue: 18,
    status: InvoiceStatus.HIGH_PRIORITY,
  },
  {
    invoiceNumber: "INV-2026-0052",
    customer: "GreenField Packaging Pvt Ltd",
    amount: 60000,
    daysOverdue: 9,
    status: InvoiceStatus.FOLLOW_UP_DUE,
  },
  {
    invoiceNumber: "INV-2026-0053",
    customer: "Sunrise Office Supplies",
    amount: 18000,
    daysOverdue: 2,
    status: InvoiceStatus.FOLLOW_UP_DUE,
  },
  {
    invoiceNumber: "INV-2026-0054",
    customer: "MetroSteel Traders",
    amount: 70000,
    daysOverdue: 16,
    status: InvoiceStatus.PROMISE_TO_PAY,
  },

  {
    invoiceNumber: "INV-2026-0055",
    customer: "Demo Recovery Labs Pvt Ltd",
    amount: 2000,
    daysOverdue: 40,
    status: InvoiceStatus.HIGH_PRIORITY,
  },

  {
    invoiceNumber: "INV-2026-0041",
    customer: "Crust & Crumble Pvt Ltd",
    amount: 11000,
    daysOverdue: 35,
    status: InvoiceStatus.HIGH_PRIORITY,
  },


];

async function main() {
  await prisma.recoveryPolicy.upsert({
    where: {
      merchantKey,
    },
    update: {},
    create: {
      merchantKey,
      maxExtensionDays: 14,
      maxDiscountPercent: 2,
      maxRemindersPerWeek: 3,
      humanEscalationThresholdDays: 45,
      requireHumanApprovalForDiscount: true,
      allowWhatsapp: true,
      allowEmail: true,
      allowVoice: false,
      stopOnOptOut: true,
      stopOnDispute: true,
    },
  });

  for (const invoiceData of invoices) {
    const invoice = await prisma.invoice.upsert({
      where: {
        invoiceNumber: invoiceData.invoiceNumber,
      },
      update: {},
      create: invoiceData,
    });

    const existingImportEvent = await prisma.auditLog.findFirst({
      where: {
        invoiceId: invoice.id,
        eventType: AuditEventType.INVOICE_IMPORTED,
      },
    });

    if (!existingImportEvent) {
      await prisma.auditLog.create({
        data: {
          invoiceId: invoice.id,
          eventType: AuditEventType.INVOICE_IMPORTED,
          actorType: "SYSTEM",
          summary: `Invoice ${invoice.invoiceNumber} was imported into the recovery queue.`,
          metadata: {
            source: "demo-seed",
            initialStatus: invoice.status,
            initialDaysOverdue: invoice.daysOverdue,
            initialAmount: invoice.amount,
          },
        },
      });
    }
  }

    const missedPromiseInvoice = await prisma.invoice.findUnique({
    where: {
      invoiceNumber: "INV-2026-0054",
    },
  });

  const existingMissedPromise = await prisma.promiseToPay.findFirst({
    where: {
      invoiceId: missedPromiseInvoice.id,
      status: "ACTIVE",
    },
  });

  if (!existingMissedPromise) {
    await prisma.promiseToPay.create({
      data: {
        invoiceId: missedPromiseInvoice.id,
        promisedAmount: missedPromiseInvoice.amount,
        promisedPaymentDate: new Date("2026-08-25T00:00:00"),
        status: "ACTIVE",
        createdBy: "DEMO_SEED",
      },
    });
  }

  console.log("Seeded merchant policy, invoices, audit events, and action-test scenarios.");
}

main()
  .catch((error) => {
    console.error("Database seeding failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });