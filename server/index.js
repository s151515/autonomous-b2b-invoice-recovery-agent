require("dotenv").config();

const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
const express = require("express");
const Razorpay = require("razorpay");
const {
  PrismaClient,
  AuditEventType,
  InvoiceStatus,
  PromiseToPayStatus,
  UrgencyBand,
  RecoveryAction,
} = require("@prisma/client");

const app = express();
const prisma = new PrismaClient();
const PORT = 4000;
const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});


async function interpretCustomerReply({ customerMessage, invoice }) {
  const currentDate = formatDateOnly(new Date());

  const prompt = `
You are a B2B receivables customer-reply interpreter.

Interpret the customer message only. Do not make financial decisions, approve
discounts, promise extensions, threaten the customer, or claim payment was
received. The merchant policy engine makes all final decisions.

Current date: ${currentDate}

Invoice context:
- Invoice number: ${invoice.invoiceNumber}
- Customer: ${invoice.customer}
- Outstanding amount: INR ${invoice.amount}
- Days overdue: ${invoice.daysOverdue}

Customer message:
${customerMessage}

Interpretation rules:
- WILL_PAY_NOW: customer says they will pay immediately.
- PROMISE_TO_PAY: customer clearly commits to paying on a particular date.
- REQUEST_EXTENSION: customer asks for more time without a firm commitment.
- REQUEST_PAYMENT_LINK: customer asks for a payment link.
- REQUEST_DISCOUNT: customer asks for a discount, waiver, or reduced amount.
- PARTIAL_PAYMENT: customer offers a partial amount.
- DISPUTE_INVOICE: customer says the amount, invoice, service, or delivery is incorrect/disputed.
- OPT_OUT: customer asks to stop messages/contact.
- HUMAN_ESCALATION_REQUEST: customer explicitly asks to speak with a human.
- UNCLEAR: any ambiguous reply.

Resolve relative dates such as "tomorrow" or "next Friday" using the current date.
Use YYYY-MM-DD for proposedPaymentDate, or null if there is no clear date.
Use null for non-applicable number/string fields.
`;

  const response = await gemini.interactions.create({
    model: "gemini-3.6-flash",
    input: prompt,
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          intent: {
            type: "string",
            enum: [
              "WILL_PAY_NOW",
              "PROMISE_TO_PAY",
              "REQUEST_EXTENSION",
              "REQUEST_PAYMENT_LINK",
              "REQUEST_DISCOUNT",
              "PARTIAL_PAYMENT",
              "DISPUTE_INVOICE",
              "OPT_OUT",
              "HUMAN_ESCALATION_REQUEST",
              "UNCLEAR",
            ],
          },
          proposedPaymentDate: {
            type: ["string", "null"],
          },
          requestedDiscountPercent: {
            type: ["number", "null"],
          },
          requestedPartialAmount: {
            type: ["number", "null"],
          },
          disputeDetected: {
            type: "boolean",
          },
          optOutDetected: {
            type: "boolean",
          },
          reason: {
            type: ["string", "null"],
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
        },
        required: [
          "intent",
          "proposedPaymentDate",
          "requestedDiscountPercent",
          "requestedPartialAmount",
          "disputeDetected",
          "optOutDetected",
          "reason",
          "confidence",
        ],
      },
    },
  });

  const responseText = response.output_text;

  if (!responseText) {
    throw new Error("Gemini returned an empty response.");
  }

  return JSON.parse(responseText);
}

function formatEnumLabel(value) {
  return value
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

function formatInvoiceStatus(status) {
  return formatEnumLabel(status);
}

function formatUrgencyBand(band) {
  return formatEnumLabel(band);
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function isValidRazorpayWebhook(rawBody, receivedSignature) {
  if (!receivedSignature || !process.env.RAZORPAY_WEBHOOK_SECRET) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(receivedSignature)
    );
  } catch {
    return false;
  }
}

async function processRazorpayPaymentLinkPaid(payload) {
  const paymentLink = payload.payload?.payment_link?.entity;
  const payment = payload.payload?.payment?.entity;

  if (!paymentLink || !payment) {
    throw new Error("Webhook payload is missing payment-link or payment data.");
  }

  const razorpayLinkId = paymentLink.id;
  const razorpayPaymentId = payment.id;
  const paidAt = payment.created_at
    ? new Date(payment.created_at * 1000)
    : new Date();

  const storedLink = await prisma.paymentLink.findUnique({
    where: {
      razorpayLinkId,
    },
    include: {
      invoice: true,
    },
  });

  if (!storedLink) {
    throw new Error(
      `No internal PaymentLink record exists for Razorpay link ${razorpayLinkId}.`
    );
  }

  if (storedLink.razorpayPaymentId === razorpayPaymentId) {
    return {
      alreadyProcessed: true,
      invoiceNumber: storedLink.invoice.invoiceNumber,
    };
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.paymentLink.update({
      where: {
        id: storedLink.id,
      },
      data: {
        status: "paid",
        razorpayPaymentId,
        paidAt,
      },
    });

    await transaction.invoice.update({
      where: {
        id: storedLink.invoiceId,
      },
      data: {
        status: InvoiceStatus.RECOVERED,
      },
    });

    await transaction.promiseToPay.updateMany({
      where: {
        invoiceId: storedLink.invoiceId,
        status: PromiseToPayStatus.ACTIVE,
      },
      data: {
        status: PromiseToPayStatus.KEPT,
      },
    });

    await transaction.auditLog.create({
      data: {
        invoiceId: storedLink.invoiceId,
        eventType: AuditEventType.PAYMENT_CONFIRMED,
        actorType: "RAZORPAY_WEBHOOK",
        summary: `Payment confirmed by Razorpay: ₹${storedLink.amount} received.`,
        metadata: {
          razorpayLinkId,
          razorpayPaymentId,
          amount: storedLink.amount,
          currency: storedLink.currency,
          paidAt,
        },
      },
    });

    await transaction.auditLog.create({
      data: {
        invoiceId: storedLink.invoiceId,
        eventType: AuditEventType.INVOICE_RECOVERED,
        actorType: "RECOVERY_ENGINE",
        summary: `Invoice ${storedLink.invoice.invoiceNumber} marked RECOVERED after verified Razorpay payment.`,
        metadata: {
          paymentLinkId: storedLink.id,
          razorpayLinkId,
          razorpayPaymentId,
        },
      },
    });
  });

  return {
    alreadyProcessed: false,
    invoiceNumber: storedLink.invoice.invoiceNumber,
  };
}

app.post(
  "/api/webhooks/razorpay",
  express.raw({ type: "application/json" }),
  async (request, response) => {
    const rawBody = request.body;
    const receivedSignature = request.get("x-razorpay-signature");

    if (!isValidRazorpayWebhook(rawBody, receivedSignature)) {
      console.warn("Rejected Razorpay webhook with invalid signature.");

      return response.status(400).json({
        success: false,
        message: "Invalid webhook signature.",
      });
    }

    let payload;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (error) {
      return response.status(400).json({
        success: false,
        message: "Invalid JSON webhook body.",
      });
    }

    try {
      if (payload.event !== "payment_link.paid") {
        return response.status(200).json({
          success: true,
          ignored: true,
          message: `Ignored event: ${payload.event}`,
        });
      }

      const result = await processRazorpayPaymentLinkPaid(payload);

      return response.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("Could not process Razorpay webhook:", error);

      return response.status(500).json({
        success: false,
        message: "Webhook processing failed.",
      });
    }
  }
);

app.use(express.json());
app.post(
  "/api/dev/payment-links/:razorpayLinkId/mark-paid",
  async (request, response) => {
    if (process.env.NODE_ENV === "production") {
      return response.status(404).json({
        success: false,
        message: "Not found.",
      });
    }

    try {
      const storedLink = await prisma.paymentLink.findUnique({
        where: {
          razorpayLinkId: request.params.razorpayLinkId,
        },
        include: {
          invoice: true,
        },
      });

      if (!storedLink) {
        return response.status(404).json({
          success: false,
          message: "Payment link not found.",
        });
      }

      if (
        storedLink.status === "paid" &&
        storedLink.invoice.status === InvoiceStatus.RECOVERED
      ) {
        return response.json({
          success: true,
          alreadyProcessed: true,
          message: "This payment link and invoice were already marked as recovered.",
          invoiceNumber: storedLink.invoice.invoiceNumber,
        });
      }
      const simulatedPaymentId = `pay_demo_${Date.now()}`;
      const paidAt = new Date();

      await prisma.$transaction(async (transaction) => {
        await transaction.paymentLink.update({
          where: {
            id: storedLink.id,
          },
          data: {
            status: "paid",
            razorpayPaymentId:
              storedLink.razorpayPaymentId ?? simulatedPaymentId,
            paidAt: storedLink.paidAt ?? paidAt,
          },
        });
        
        await transaction.invoice.update({
          where: {
            id: storedLink.invoiceId,
          },
          data: {
            status: InvoiceStatus.RECOVERED,
          },
        });

        await transaction.promiseToPay.updateMany({
          where: {
            invoiceId: storedLink.invoiceId,
            status: PromiseToPayStatus.ACTIVE,
          },
          data: {
            status: PromiseToPayStatus.KEPT,
          },
        });

        await transaction.auditLog.create({
          data: {
            invoiceId: storedLink.invoiceId,
            eventType: AuditEventType.PAYMENT_CONFIRMED,
            actorType: "DEV_WEBHOOK_SIMULATOR",
            summary: `Development webhook simulation: payment confirmed for ₹${storedLink.amount}.`,
            metadata: {
              razorpayLinkId: storedLink.razorpayLinkId,
              simulatedPaymentId,
              amount: storedLink.amount,
              currency: storedLink.currency,
              paidAt,
              mode: "development-simulation",
            },
          },
        });

        await transaction.auditLog.create({
          data: {
            invoiceId: storedLink.invoiceId,
            eventType: AuditEventType.INVOICE_RECOVERED,
            actorType: "RECOVERY_ENGINE",
            summary: `Invoice ${storedLink.invoice.invoiceNumber} marked RECOVERED after development payment simulation.`,
            metadata: {
              paymentLinkId: storedLink.id,
              razorpayLinkId: storedLink.razorpayLinkId,
              simulatedPaymentId,
              mode: "development-simulation",
            },
          },
        });
      });

      const updatedInvoice = await prisma.invoice.findUnique({
        where: {
          id: storedLink.invoiceId,
        },
      });

      await scoreAndRecommendInvoiceIfChanged(updatedInvoice);

      return response.status(200).json({
        success: true,
        alreadyProcessed: false,
        message: "Development payment simulation completed successfully.",
        invoiceNumber: storedLink.invoice.invoiceNumber,
        simulatedPaymentId,
      });
    } catch (error) {
      console.error("Development payment simulation failed:", error);

      return response.status(500).json({
        success: false,
        message: "Development payment simulation failed.",
      });
    }
  }
);

function calculateUrgency(invoice, hasActivePromise) {
  let score = 0;
  const reasons = [];

  if (invoice.status === InvoiceStatus.RECOVERED) {
    return {
      score: 0,
      band: UrgencyBand.LOW,
      reasons: ["Invoice has been recovered"],
    };
  }

  if (invoice.daysOverdue <= 0) {
    reasons.push("Invoice is not overdue");
  } else if (invoice.daysOverdue <= 7) {
    score += 15;
    reasons.push(`${invoice.daysOverdue} days overdue (+15)`);
  } else if (invoice.daysOverdue <= 14) {
    score += 30;
    reasons.push(`${invoice.daysOverdue} days overdue (+30)`);
  } else if (invoice.daysOverdue <= 30) {
    score += 45;
    reasons.push(`${invoice.daysOverdue} days overdue (+45)`);
  } else {
    score += 60;
    reasons.push(`${invoice.daysOverdue} days overdue (+60)`);
  }

  if (invoice.amount >= 100000) {
    score += 20;
    reasons.push(`High-value invoice ₹${invoice.amount} (+20)`);
  } else if (invoice.amount >= 50000) {
    score += 10;
    reasons.push(`Mid-value invoice ₹${invoice.amount} (+10)`);
  } else {
    reasons.push(`Invoice value ₹${invoice.amount} (+0)`);
  }

  if (hasActivePromise) {
    score -= 10;
    reasons.push("Active promise-to-pay exists (-10)");
  } else {
    score += 15;
    reasons.push("No active promise-to-pay (+15)");
  }

  score = Math.max(0, Math.min(score, 100));

  let band = UrgencyBand.LOW;

  if (score >= 75) {
    band = UrgencyBand.CRITICAL;
  } else if (score >= 50) {
    band = UrgencyBand.HIGH;
  } else if (score >= 25) {
    band = UrgencyBand.MEDIUM;
  }

  return { score, band, reasons };
}

function determineNextAction(invoice, activePromise) {
  if (invoice.status === InvoiceStatus.RECOVERED) {
    return {
      action: RecoveryAction.MONITOR_INVOICE,
      reason: "Invoice is recovered. All automated recovery activity is stopped.",
    };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (activePromise) {
    const promiseDate = new Date(activePromise.promisedPaymentDate);
    promiseDate.setHours(0, 0, 0, 0);

    if (promiseDate < today) {
      return {
        action: RecoveryAction.SEND_PROMISE_REMINDER,
        reason: `Customer promise-to-pay date ${formatDateOnly(
          promiseDate
        )} has passed without confirmed payment.`,
      };
    }

    return {
      action: RecoveryAction.WAIT_FOR_PROMISED_PAYMENT,
      reason: `An active promise-to-pay exists for ${formatDateOnly(
        promiseDate
      )}. Do not send another recovery reminder before that date.`,
    };
  }

  if (invoice.urgencyBand === UrgencyBand.CRITICAL) {
    return {
      action: RecoveryAction.SEND_PAYMENT_LINK,
      reason:
        "Critical urgency with no active promise-to-pay. Prioritize a direct payment-link recovery attempt.",
    };
  }

  if (invoice.urgencyBand === UrgencyBand.HIGH) {
    return {
      action: RecoveryAction.SEND_EMAIL_AND_WHATSAPP_REMINDER,
      reason:
        "High urgency with no active promise-to-pay. Send a coordinated email and WhatsApp reminder.",
    };
  }

  if (invoice.urgencyBand === UrgencyBand.MEDIUM) {
    return {
      action: RecoveryAction.SEND_EMAIL_REMINDER,
      reason:
        "Medium urgency with no active promise-to-pay. Send a polite email reminder.",
    };
  }

  return {
    action: RecoveryAction.MONITOR_INVOICE,
    reason:
      "Low urgency. Continue monitoring without sending a recovery message yet.",
  };
}

async function scoreAndRecommendInvoiceIfChanged(invoice) {
  const activePromise = await prisma.promiseToPay.findFirst({
    where: {
      invoiceId: invoice.id,
      status: PromiseToPayStatus.ACTIVE,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const urgency = calculateUrgency(invoice, Boolean(activePromise));

  const actionInput = {
    ...invoice,
    urgencyScore: urgency.score,
    urgencyBand: urgency.band,
  };

  const recommendation = determineNextAction(actionInput, activePromise);

  const urgencyChanged =
    invoice.urgencyScore !== urgency.score ||
    invoice.urgencyBand !== urgency.band;

  const actionChanged =
    invoice.recommendedAction !== recommendation.action ||
    invoice.actionReason !== recommendation.reason;

  if (!urgencyChanged && !actionChanged) {
    return {
      urgency,
      recommendation,
      activePromise,
    };
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.invoice.update({
      where: {
        id: invoice.id,
      },
      data: {
        urgencyScore: urgency.score,
        urgencyBand: urgency.band,
        recommendedAction: recommendation.action,
        actionReason: recommendation.reason,
      },
    });

    if (urgencyChanged) {
      await transaction.auditLog.create({
        data: {
          invoiceId: invoice.id,
          eventType: AuditEventType.URGENCY_SCORED,
          actorType: "URGENCY_ENGINE",
          summary: `Urgency scored ${urgency.score}/100 (${urgency.band}). ${urgency.reasons.join(
            "; "
          )}.`,
          metadata: {
            score: urgency.score,
            band: urgency.band,
            reasons: urgency.reasons,
            hasActivePromise: Boolean(activePromise),
          },
        },
      });
    }

    if (actionChanged) {
      await transaction.auditLog.create({
        data: {
          invoiceId: invoice.id,
          eventType: AuditEventType.NEXT_ACTION_RECOMMENDED,
          actorType: "RECOVERY_ENGINE",
          summary: `Next action recommended: ${recommendation.action}. ${recommendation.reason}`,
          metadata: {
            recommendedAction: recommendation.action,
            actionReason: recommendation.reason,
            urgencyScore: urgency.score,
            urgencyBand: urgency.band,
            activePromiseId: activePromise?.id ?? null,
          },
        },
      });
    }
  });

  return {
    urgency,
    recommendation,
    activePromise,
  };
}

async function scoreAndRecommendAllInvoices() {
  const invoices = await prisma.invoice.findMany({
    orderBy: {
      invoiceNumber: "asc",
    },
  });

  for (const invoice of invoices) {
    await scoreAndRecommendInvoiceIfChanged(invoice);
  }
}

function mapPaymentLink(paymentLink) {
  return {
    id: paymentLink.id,
    razorpayLinkId: paymentLink.razorpayLinkId,
    shortUrl: paymentLink.shortUrl,
    status: paymentLink.status,
    razorpayPaymentId: paymentLink.razorpayPaymentId,
    paidAt: paymentLink.paidAt,
    amount: paymentLink.amount,
    currency: paymentLink.currency,
    referenceId: paymentLink.referenceId,
    expiresAt: paymentLink.expiresAt,
    createdAt: paymentLink.createdAt,
    updatedAt: paymentLink.updatedAt,
  };
}

function buildInvoiceDetail(invoice) {
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    customer: invoice.customer,
    amount: invoice.amount,
    daysOverdue: invoice.daysOverdue,
    status: formatInvoiceStatus(invoice.status),
    urgencyScore: invoice.urgencyScore,
    urgencyBand: formatUrgencyBand(invoice.urgencyBand),
    recommendedAction: formatEnumLabel(invoice.recommendedAction),
    actionReason: invoice.actionReason,
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
    promisesToPay: invoice.promisesToPay.map((promise) => ({
      id: promise.id,
      promisedAmount: promise.promisedAmount,
      promisedPaymentDate: promise.promisedPaymentDate,
      status: promise.status,
      createdBy: promise.createdBy,
      createdAt: promise.createdAt,
      updatedAt: promise.updatedAt,
    })),
    paymentLinks: invoice.paymentLinks.map(mapPaymentLink),
    auditLogs: invoice.auditLogs.map((auditLog) => ({
      id: auditLog.id,
      eventType: auditLog.eventType,
      actorType: auditLog.actorType,
      summary: auditLog.summary,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })),
  };
}

app.post(
  "/api/invoices/:invoiceNumber/interpret-reply",
  async (request, response) => {
    try {
      const { customerMessage } = request.body;

      if (!customerMessage || !customerMessage.trim()) {
        return response.status(400).json({
          success: false,
          message: "customerMessage is required.",
        });
      }

      const invoice = await prisma.invoice.findUnique({
        where: {
          invoiceNumber: request.params.invoiceNumber,
        },
      });

      if (!invoice) {
        return response.status(404).json({
          success: false,
          message: "Invoice not found.",
        });
      }

      const interpretation = await interpretCustomerReply({
        customerMessage: customerMessage.trim(),
        invoice,
      });

      await prisma.$transaction(async (transaction) => {
        await transaction.auditLog.create({
          data: {
            invoiceId: invoice.id,
            eventType: AuditEventType.CUSTOMER_REPLY_RECEIVED,
            actorType: "CUSTOMER",
            summary: "Customer reply received for AI interpretation.",
            metadata: {
              customerMessage: customerMessage.trim(),
            },
          },
        });

        await transaction.auditLog.create({
          data: {
            invoiceId: invoice.id,
            eventType: AuditEventType.AI_REPLY_INTERPRETED,
            actorType: "AI_INTERPRETER",
            summary: `AI interpreted customer reply as ${interpretation.intent}.`,
            metadata: {
              customerMessage: customerMessage.trim(),
              interpretation,
              model: "gpt-4o-mini",
            },
          },
        });

        if (
          interpretation.optOutDetected ||
          interpretation.disputeDetected ||
          interpretation.intent === "HUMAN_ESCALATION_REQUEST"
        ) {
          const stopReason = interpretation.optOutDetected
            ? "Customer opted out of automated contact."
            : interpretation.disputeDetected
              ? "Customer disputed the invoice."
              : "Customer requested human escalation.";

          await transaction.auditLog.create({
            data: {
              invoiceId: invoice.id,
              eventType: AuditEventType.AUTOMATION_STOPPED,
              actorType: "SAFETY_ENGINE",
              summary: `Automation stopped: ${stopReason}`,
              metadata: {
                stopReason,
                interpretation,
              },
            },
          });
        }
      });

      response.json({
        success: true,
        data: interpretation,
      });
    } catch (error) {
      console.error("Could not interpret customer reply:", error);

      response.status(500).json({
        success: false,
        message:
          "Could not interpret the customer reply. Check your Gemini API key, free-tier availability, and backend terminal.",
      });
    }
  }
);

app.post(
  "/api/invoices/:invoiceNumber/execute-ai-interpretation",
  async (request, response) => {
    try {
      const { interpretation } = request.body;

      if (!interpretation || !interpretation.intent) {
        return response.status(400).json({
          success: false,
          message: "A structured AI interpretation is required.",
        });
      }

      const invoice = await prisma.invoice.findUnique({
        where: {
          invoiceNumber: request.params.invoiceNumber,
        },
      });

      if (!invoice) {
        return response.status(404).json({
          success: false,
          message: "Invoice not found.",
        });
      }

      if (invoice.status === InvoiceStatus.RECOVERED) {
        return response.status(409).json({
          success: false,
          message: "Recovered invoices cannot enter a new recovery workflow.",
        });
      }

      const policy = await prisma.recoveryPolicy.findUnique({
        where: {
          merchantKey: "merchant_demo_01",
        },
      });

      if (!policy) {
        return response.status(404).json({
          success: false,
          message: "Merchant recovery policy not found.",
        });
      }

      const allowedIntents = [
        "WILL_PAY_NOW",
        "PROMISE_TO_PAY",
        "REQUEST_EXTENSION",
        "REQUEST_PAYMENT_LINK",
        "REQUEST_DISCOUNT",
        "PARTIAL_PAYMENT",
        "DISPUTE_INVOICE",
        "OPT_OUT",
        "HUMAN_ESCALATION_REQUEST",
        "UNCLEAR",
      ];

      if (!allowedIntents.includes(interpretation.intent)) {
        return response.status(400).json({
          success: false,
          message: "The AI interpretation contains an unsupported intent.",
        });
      }

      const mustStopAutomation =
        interpretation.optOutDetected === true ||
        interpretation.intent === "OPT_OUT";

      const mustEscalate =
        interpretation.disputeDetected === true ||
        interpretation.intent === "DISPUTE_INVOICE" ||
        interpretation.intent === "HUMAN_ESCALATION_REQUEST" ||
        interpretation.intent === "REQUEST_DISCOUNT" ||
        interpretation.intent === "PARTIAL_PAYMENT";

      if (mustStopAutomation) {
        await prisma.$transaction(async (transaction) => {
          await transaction.invoice.update({
            where: {
              id: invoice.id,
            },
            data: {
              status: InvoiceStatus.OPTED_OUT,
            },
          });

          await transaction.auditLog.create({
            data: {
              invoiceId: invoice.id,
              eventType: AuditEventType.AI_POLICY_EXECUTION,
              actorType: "AI_POLICY_BRIDGE",
              summary:
                "AI interpretation executed: customer opt-out detected. Automated recovery has been stopped.",
              metadata: {
                intent: interpretation.intent,
                execution: "OPT_OUT_AND_STOP_AUTOMATION",
                interpretation,
              },
            },
          });
        });

        const updatedInvoice = await prisma.invoice.findUnique({
          where: { id: invoice.id },
        });

        await scoreAndRecommendInvoiceIfChanged(updatedInvoice);

        return response.json({
          success: true,
          data: {
            outcome: "AUTOMATION_STOPPED",
            message:
              "Customer opt-out applied. Automated recovery has been stopped.",
          },
        });
      }

      if (mustEscalate) {
        let escalationReason = "Human review required.";

        if (
          interpretation.disputeDetected ||
          interpretation.intent === "DISPUTE_INVOICE"
        ) {
          escalationReason =
            "Invoice dispute detected. Automated recovery cannot continue.";
        } else if (interpretation.intent === "REQUEST_DISCOUNT") {
          escalationReason =
            "Customer requested a discount. Discount decisions require human approval.";
        } else if (interpretation.intent === "PARTIAL_PAYMENT") {
          escalationReason =
            "Customer proposed a partial payment. Payment-term changes require human review.";
        } else if (
          interpretation.intent === "HUMAN_ESCALATION_REQUEST"
        ) {
          escalationReason =
            "Customer explicitly requested a human representative.";
        }

        await prisma.$transaction(async (transaction) => {
          await transaction.invoice.update({
            where: {
              id: invoice.id,
            },
            data: {
              status: InvoiceStatus.HUMAN_REVIEW,
            },
          });

          await transaction.auditLog.create({
            data: {
              invoiceId: invoice.id,
              eventType: AuditEventType.HUMAN_REVIEW_REQUESTED,
              actorType: "AI_POLICY_BRIDGE",
              summary: escalationReason,
              metadata: {
                intent: interpretation.intent,
                execution: "ESCALATE_TO_HUMAN",
                interpretation,
              },
            },
          });

          await transaction.auditLog.create({
            data: {
              invoiceId: invoice.id,
              eventType: AuditEventType.AI_POLICY_EXECUTION,
              actorType: "AI_POLICY_BRIDGE",
              summary: `AI interpretation executed: escalated to human review. ${escalationReason}`,
              metadata: {
                intent: interpretation.intent,
                execution: "ESCALATE_TO_HUMAN",
                interpretation,
              },
            },
          });
        });

        const updatedInvoice = await prisma.invoice.findUnique({
          where: { id: invoice.id },
        });

        await scoreAndRecommendInvoiceIfChanged(updatedInvoice);

        return response.json({
          success: true,
          data: {
            outcome: "HUMAN_REVIEW_REQUIRED",
            message: escalationReason,
          },
        });
      }

      if (
        interpretation.intent === "PROMISE_TO_PAY" ||
        interpretation.intent === "REQUEST_EXTENSION"
      ) {
        if (!interpretation.proposedPaymentDate) {
          await prisma.auditLog.create({
            data: {
              invoiceId: invoice.id,
              eventType: AuditEventType.AI_POLICY_EXECUTION,
              actorType: "AI_POLICY_BRIDGE",
              summary:
                "AI interpretation requires clarification because no specific payment date was provided.",
              metadata: {
                intent: interpretation.intent,
                execution: "REQUEST_SPECIFIC_PAYMENT_DATE",
                interpretation,
              },
            },
          });

          return response.json({
            success: true,
            data: {
              outcome: "NEEDS_CLARIFICATION",
              message:
                "Ask the customer for a specific payment date before creating a Promise-to-Pay.",
            },
          });
        }

        const proposedDate = new Date(
          `${interpretation.proposedPaymentDate}T00:00:00`
        );

        if (Number.isNaN(proposedDate.getTime())) {
          return response.status(400).json({
            success: false,
            message:
              "The AI response contained an invalid proposed payment date.",
          });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const maximumAllowedDate = addDays(
          today,
          policy.maxExtensionDays
        );

        let decision = "APPROVED";
        let reason = `Payment date is within the merchant limit of ${policy.maxExtensionDays} extension days.`;
        let nextAction = "CREATE_PROMISE_TO_PAY";

        if (proposedDate < today) {
          decision = "ESCALATE";
          reason = "The proposed payment date is in the past.";
          nextAction = "REQUEST_NEW_DATE";
        } else if (proposedDate > maximumAllowedDate) {
          decision = "ESCALATE";
          reason = `The proposed date exceeds the merchant limit of ${policy.maxExtensionDays} extension days.`;
          nextAction = "HUMAN_REVIEW_REQUIRED";
        } else if (
          invoice.daysOverdue >= policy.humanEscalationThresholdDays
        ) {
          decision = "ESCALATE";
          reason = `Invoice is ${invoice.daysOverdue} days overdue, reaching the merchant's human escalation threshold of ${policy.humanEscalationThresholdDays} days.`;
          nextAction = "HUMAN_REVIEW_REQUIRED";
        }

        const result = await prisma.$transaction(async (transaction) => {
          await transaction.auditLog.create({
            data: {
              invoiceId: invoice.id,
              eventType: AuditEventType.POLICY_EVALUATION,
              actorType: "POLICY_ENGINE",
              summary: `${decision}: AI-extracted payment date ${formatDateOnly(
                proposedDate
              )}. ${reason}`,
              metadata: {
                source: "AI_POLICY_BRIDGE",
                intent: interpretation.intent,
                proposedPaymentDate: interpretation.proposedPaymentDate,
                decision,
                reason,
                nextAction,
                maxExtensionDays: policy.maxExtensionDays,
              },
            },
          });

          await transaction.auditLog.create({
            data: {
              invoiceId: invoice.id,
              eventType: AuditEventType.AI_POLICY_EXECUTION,
              actorType: "AI_POLICY_BRIDGE",
              summary: `AI interpretation executed through policy engine: ${decision}.`,
              metadata: {
                intent: interpretation.intent,
                execution: "EVALUATE_PROMISE_DATE",
                decision,
                reason,
                interpretation,
              },
            },
          });

          if (decision !== "APPROVED") {
            await transaction.invoice.update({
              where: {
                id: invoice.id,
              },
              data: {
                status: InvoiceStatus.HUMAN_REVIEW,
              },
            });

            await transaction.auditLog.create({
              data: {
                invoiceId: invoice.id,
                eventType: AuditEventType.HUMAN_REVIEW_REQUESTED,
                actorType: "POLICY_ENGINE",
                summary: `Human review required: ${reason}`,
                metadata: {
                  reason,
                  source: "AI_POLICY_BRIDGE",
                },
              },
            });

            return {
              promise: null,
              promiseAction: null,
            };
          }

          const activePromise = await transaction.promiseToPay.findFirst({
            where: {
              invoiceId: invoice.id,
              status: PromiseToPayStatus.ACTIVE,
            },
            orderBy: {
              createdAt: "desc",
            },
          });

          let promise;
          let promiseAction;
          let promiseAuditEventType;
          let promiseAuditSummary;

          if (activePromise) {
            promise = await transaction.promiseToPay.update({
              where: {
                id: activePromise.id,
              },
              data: {
                promisedAmount: invoice.amount,
                promisedPaymentDate: proposedDate,
                createdBy: "AI_POLICY_BRIDGE",
              },
            });

            promiseAction = "UPDATED";
            promiseAuditEventType = AuditEventType.PROMISE_TO_PAY_UPDATED;
            promiseAuditSummary = `Promise-to-pay updated from AI-extracted date: ${formatDateOnly(
              proposedDate
            )} for ₹${invoice.amount}.`;
          } else {
            promise = await transaction.promiseToPay.create({
              data: {
                invoiceId: invoice.id,
                promisedAmount: invoice.amount,
                promisedPaymentDate: proposedDate,
                status: PromiseToPayStatus.ACTIVE,
                createdBy: "AI_POLICY_BRIDGE",
              },
            });

            promiseAction = "CREATED";
            promiseAuditEventType = AuditEventType.PROMISE_TO_PAY_CREATED;
            promiseAuditSummary = `Promise-to-pay created from AI-extracted date: ${formatDateOnly(
              proposedDate
            )} for ₹${invoice.amount}.`;
          }

          await transaction.invoice.update({
            where: {
              id: invoice.id,
            },
            data: {
              status: InvoiceStatus.PROMISE_TO_PAY,
            },
          });

          await transaction.auditLog.create({
            data: {
              invoiceId: invoice.id,
              eventType: promiseAuditEventType,
              actorType: "AI_POLICY_BRIDGE",
              summary: promiseAuditSummary,
              metadata: {
                promiseId: promise.id,
                promiseAction,
                promisedAmount: promise.promisedAmount,
                promisedPaymentDate: formatDateOnly(
                  promise.promisedPaymentDate
                ),
                source: "AI_POLICY_BRIDGE",
              },
            },
          });

          return {
            promise,
            promiseAction,
          };
        });

        const updatedInvoice = await prisma.invoice.findUnique({
          where: {
            id: invoice.id,
          },
        });

        await scoreAndRecommendInvoiceIfChanged(updatedInvoice);

        return response.json({
          success: true,
          data: {
            outcome:
              decision === "APPROVED"
                ? "PROMISE_TO_PAY_RECORDED"
                : "HUMAN_REVIEW_REQUIRED",
            decision,
            reason,
            nextAction,
            promiseAction: result.promiseAction,
            promise: result.promise
              ? {
                  id: result.promise.id,
                  promisedAmount: result.promise.promisedAmount,
                  promisedPaymentDate: result.promise.promisedPaymentDate,
                  status: result.promise.status,
                }
              : null,
          },
        });
      }

      if (
        interpretation.intent === "REQUEST_PAYMENT_LINK" ||
        interpretation.intent === "WILL_PAY_NOW"
      ) {
        await prisma.auditLog.create({
          data: {
            invoiceId: invoice.id,
            eventType: AuditEventType.AI_POLICY_EXECUTION,
            actorType: "AI_POLICY_BRIDGE",
            summary:
              "AI interpretation indicates payment intent. Existing payment-link eligibility rules remain in effect.",
            metadata: {
              intent: interpretation.intent,
              execution: "SHOW_PAYMENT_LINK_IF_ELIGIBLE",
              interpretation,
            },
          },
        });

        return response.json({
          success: true,
          data: {
            outcome: "PAYMENT_INTENT_DETECTED",
            message:
              "Customer wants to pay. Use the existing Razorpay payment-link action only when the recovery engine marks the invoice eligible.",
          },
        });
      }

      await prisma.auditLog.create({
        data: {
          invoiceId: invoice.id,
          eventType: AuditEventType.AI_POLICY_EXECUTION,
          actorType: "AI_POLICY_BRIDGE",
          summary:
            "AI interpretation is unclear. No financial or workflow state was changed.",
          metadata: {
            intent: interpretation.intent,
            execution: "REQUEST_CLARIFICATION",
            interpretation,
          },
        },
      });

      return response.json({
        success: true,
        data: {
          outcome: "NEEDS_CLARIFICATION",
          message:
            "Ask the customer for a specific payment date or clarification before proceeding.",
        },
      });
    } catch (error) {
      console.error("Could not execute AI interpretation:", error);

      response.status(500).json({
        success: false,
        message: "Could not execute the AI interpretation safely.",
      });
    }
  }
);
app.get("/api/health", async (request, response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    response.json({
      status: "ok",
      service: "invoice-recovery-api",
      database: "connected",
    });
  } catch (error) {
    console.error("Database health check failed:", error);

    response.status(500).json({
      status: "error",
      service: "invoice-recovery-api",
      database: "disconnected",
    });
  }
});

app.get("/api/metrics", async (request, response) => {
  try {
    const [
      totalPortfolio,
      recoveredPortfolio,
      activePipeline,
      promiseToPayPortfolio,
      humanReviewCount,
      optedOutCount,
      recoveredCount,
      activePipelineCount,
    ] = await Promise.all([
      prisma.invoice.aggregate({
        _sum: {
          amount: true,
        },
      }),
      prisma.invoice.aggregate({
        where: {
          status: InvoiceStatus.RECOVERED,
        },
        _sum: {
          amount: true,
        },
      }),
      prisma.invoice.aggregate({
        where: {
          status: {
            notIn: [
              InvoiceStatus.RECOVERED,
              InvoiceStatus.OPTED_OUT,
              InvoiceStatus.HUMAN_REVIEW,
            ],
          },
        },
        _sum: {
          amount: true,
        },
      }),
      prisma.promiseToPay.aggregate({
        where: {
          status: PromiseToPayStatus.ACTIVE,
        },
        _sum: {
          promisedAmount: true,
        },
      }),
      prisma.invoice.count({
        where: {
          status: InvoiceStatus.HUMAN_REVIEW,
        },
      }),
      prisma.invoice.count({
        where: {
          status: InvoiceStatus.OPTED_OUT,
        },
      }),
      prisma.invoice.count({
        where: {
          status: InvoiceStatus.RECOVERED,
        },
      }),
      prisma.invoice.count({
        where: {
          status: {
            notIn: [
              InvoiceStatus.RECOVERED,
              InvoiceStatus.OPTED_OUT,
              InvoiceStatus.HUMAN_REVIEW,
            ],
          },
        },
      }),
    ]);

    const totalPortfolioAmount = totalPortfolio._sum.amount ?? 0;
    const recoveredAmount = recoveredPortfolio._sum.amount ?? 0;
    const activePipelineAmount = activePipeline._sum.amount ?? 0;
    const promiseToPayAmount = promiseToPayPortfolio._sum.promisedAmount ?? 0;

    const recoveryRate =
      totalPortfolioAmount === 0
        ? 0
        : Number(
            ((recoveredAmount / totalPortfolioAmount) * 100).toFixed(1)
          );

    response.json({
      success: true,
      data: {
        totalPortfolioAmount,
        recoveredAmount,
        activePipelineAmount,
        promiseToPayAmount,
        recoveryRate,
        humanReviewCount,
        optedOutCount,
        recoveredCount,
        activePipelineCount,
      },
    });
  } catch (error) {
    console.error("Could not load dashboard metrics:", error);

    response.status(500).json({
      success: false,
      message: "Could not load dashboard metrics.",
    });
  }
});

app.get("/api/recovery-exceptions", async (request, response) => {
  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        status: {
          in: [InvoiceStatus.HUMAN_REVIEW, InvoiceStatus.OPTED_OUT],
        },
      },
      orderBy: [
        { urgencyScore: "desc" },
        { updatedAt: "desc" },
      ],
    });

    response.json({
      success: true,
      count: invoices.length,
      data: invoices.map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customer: invoice.customer,
        amount: invoice.amount,
        daysOverdue: invoice.daysOverdue,
        status: formatInvoiceStatus(invoice.status),
        urgencyScore: invoice.urgencyScore,
        urgencyBand: formatUrgencyBand(invoice.urgencyBand),
        recommendedAction: formatEnumLabel(invoice.recommendedAction),
        actionReason: invoice.actionReason,
        updatedAt: invoice.updatedAt,
      })),
    });
  } catch (error) {
    console.error("Could not load recovery exceptions:", error);

    response.status(500).json({
      success: false,
      message: "Could not load recovery exceptions.",
    });
  }
});

app.get("/api/invoices", async (request, response) => {
  try {
    await scoreAndRecommendAllInvoices();

    const invoices = await prisma.invoice.findMany({
      orderBy: [
        { urgencyScore: "desc" },
        { daysOverdue: "desc" },
        { amount: "desc" },
      ],
    });

    response.json({
      success: true,
      count: invoices.length,
      data: invoices.map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customer: invoice.customer,
        amount: invoice.amount,
        daysOverdue: invoice.daysOverdue,
        status: formatInvoiceStatus(invoice.status),
        urgencyScore: invoice.urgencyScore,
        urgencyBand: formatUrgencyBand(invoice.urgencyBand),
        recommendedAction: formatEnumLabel(invoice.recommendedAction),
        actionReason: invoice.actionReason,
      })),
    });
  } catch (error) {
    console.error("Could not load invoices from PostgreSQL:", error);

    response.status(500).json({
      success: false,
      message: "Could not load invoices from the database.",
    });
  }
});

app.get("/api/invoices/:invoiceNumber", async (request, response) => {
  try {
    let invoice = await prisma.invoice.findUnique({
      where: {
        invoiceNumber: request.params.invoiceNumber,
      },
      include: {
        promisesToPay: {
          orderBy: {
            createdAt: "desc",
          },
        },
        paymentLinks: {
          orderBy: {
            createdAt: "desc",
          },
        },
        auditLogs: {
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    if (!invoice) {
      return response.status(404).json({
        success: false,
        message: "Invoice not found.",
      });
    }

    await scoreAndRecommendInvoiceIfChanged(invoice);

    invoice = await prisma.invoice.findUnique({
      where: {
        invoiceNumber: request.params.invoiceNumber,
      },
      include: {
        promisesToPay: {
          orderBy: {
            createdAt: "desc",
          },
        },
        paymentLinks: {
          orderBy: {
            createdAt: "desc",
          },
        },
        auditLogs: {
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    response.json({
      success: true,
      data: buildInvoiceDetail(invoice),
    });
  } catch (error) {
    console.error("Could not load invoice detail:", error);

    response.status(500).json({
      success: false,
      message: "Could not load invoice detail.",
    });
  }
});

app.get("/api/invoices/:invoiceNumber/next-action", async (request, response) => {
  try {
    let invoice = await prisma.invoice.findUnique({
      where: {
        invoiceNumber: request.params.invoiceNumber,
      },
      include: {
        promisesToPay: {
          where: {
            status: PromiseToPayStatus.ACTIVE,
          },
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    if (!invoice) {
      return response.status(404).json({
        success: false,
        message: "Invoice not found.",
      });
    }

    await scoreAndRecommendInvoiceIfChanged(invoice);

    invoice = await prisma.invoice.findUnique({
      where: {
        invoiceNumber: request.params.invoiceNumber,
      },
    });

    response.json({
      success: true,
      data: {
        invoiceNumber: invoice.invoiceNumber,
        urgencyScore: invoice.urgencyScore,
        urgencyBand: formatUrgencyBand(invoice.urgencyBand),
        recommendedAction: formatEnumLabel(invoice.recommendedAction),
        actionReason: invoice.actionReason,
      },
    });
  } catch (error) {
    console.error("Could not load next action:", error);

    response.status(500).json({
      success: false,
      message: "Could not load next action.",
    });
  }
});

app.get("/api/invoices/:invoiceNumber/promises", async (request, response) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: {
        invoiceNumber: request.params.invoiceNumber,
      },
    });

    if (!invoice) {
      return response.status(404).json({
        success: false,
        message: "Invoice not found.",
      });
    }

    const promises = await prisma.promiseToPay.findMany({
      where: {
        invoiceId: invoice.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    response.json({
      success: true,
      count: promises.length,
      data: promises.map((promise) => ({
        id: promise.id,
        promisedAmount: promise.promisedAmount,
        promisedPaymentDate: promise.promisedPaymentDate,
        status: promise.status,
        createdBy: promise.createdBy,
        createdAt: promise.createdAt,
        updatedAt: promise.updatedAt,
      })),
    });
  } catch (error) {
    console.error("Could not load promise-to-pay history:", error);

    response.status(500).json({
      success: false,
      message: "Could not load promise-to-pay history.",
    });
  }
});

app.get("/api/policies/:merchantKey", async (request, response) => {
  try {
    const policy = await prisma.recoveryPolicy.findUnique({
      where: {
        merchantKey: request.params.merchantKey,
      },
    });

    if (!policy) {
      return response.status(404).json({
        success: false,
        message: "Recovery policy not found.",
      });
    }

    response.json({
      success: true,
      data: policy,
    });
  } catch (error) {
    console.error("Could not load recovery policy:", error);

    response.status(500).json({
      success: false,
      message: "Could not load recovery policy.",
    });
  }
});

app.post(
  "/api/invoices/:invoiceNumber/payment-links",
  async (request, response) => {
    try {
      const invoice = await prisma.invoice.findUnique({
        where: {
          invoiceNumber: request.params.invoiceNumber,
        },
        include: {
          paymentLinks: {
            where: {
              status: "created",
            },
            orderBy: {
              createdAt: "desc",
            },
          },
        },
      });

      if (!invoice) {
        return response.status(404).json({
          success: false,
          message: "Invoice not found.",
        });
      }

      if (invoice.status === InvoiceStatus.RECOVERED) {
        return response.status(409).json({
          success: false,
          message: "Payment link creation is not allowed for a recovered invoice.",
        });
      }

      if (invoice.recommendedAction !== RecoveryAction.SEND_PAYMENT_LINK) {
        return response.status(409).json({
          success: false,
          message:
            "Payment link creation is only allowed when the recommended action is SEND_PAYMENT_LINK.",
        });
      }

      const existingActiveLink = invoice.paymentLinks[0];

      if (existingActiveLink) {
        return response.json({
          success: true,
          reused: true,
          message: "An active payment link already exists for this invoice.",
          data: mapPaymentLink(existingActiveLink),
        });
      }

      const referenceId = `${invoice.invoiceNumber}-${Date.now()}`;
      const expireBy = Math.floor(addDays(new Date(), 7).getTime() / 1000);

      let razorpayPaymentLink;

      try {
        razorpayPaymentLink = await razorpay.paymentLink.create({
          amount: invoice.amount * 100,
          currency: "INR",
          reference_id: referenceId,
          description: `Settlement for invoice ${invoice.invoiceNumber}`,
          customer: {
            name: invoice.customer,
          },
          notify: {
            sms: false,
            email: false,
          },
          reminder_enable: false,
          expire_by: expireBy,
          notes: {
            invoice_number: invoice.invoiceNumber,
            internal_invoice_id: invoice.id,
            recovery_action: invoice.recommendedAction,
          },
        });
      } catch (razorpayError) {
        console.error("Razorpay payment-link creation failed:", razorpayError);

        await prisma.auditLog.create({
          data: {
            invoiceId: invoice.id,
            eventType: AuditEventType.PAYMENT_LINK_CREATION_FAILED,
            actorType: "RAZORPAY_INTEGRATION",
            summary: "Razorpay payment-link creation failed.",
            metadata: {
              message: razorpayError.message,
              invoiceNumber: invoice.invoiceNumber,
            },
          },
        });

        return response.status(502).json({
          success: false,
          message:
            "Razorpay could not create the payment link. Check Test Mode keys and try again.",
        });
      }

      const savedPaymentLink = await prisma.paymentLink.create({
        data: {
          invoiceId: invoice.id,
          razorpayLinkId: razorpayPaymentLink.id,
          shortUrl: razorpayPaymentLink.short_url,
          status: razorpayPaymentLink.status,
          amount: invoice.amount,
          currency: razorpayPaymentLink.currency,
          referenceId: referenceId,
          expiresAt: razorpayPaymentLink.expire_by
            ? new Date(razorpayPaymentLink.expire_by * 1000)
            : null,
        },
      });

      await prisma.auditLog.create({
        data: {
          invoiceId: invoice.id,
          eventType: AuditEventType.PAYMENT_LINK_CREATED,
          actorType: "RAZORPAY_INTEGRATION",
          summary: `Razorpay Test Mode payment link created for ₹${invoice.amount}.`,
          metadata: {
            razorpayLinkId: savedPaymentLink.razorpayLinkId,
            referenceId: savedPaymentLink.referenceId,
            amount: savedPaymentLink.amount,
            currency: savedPaymentLink.currency,
            expiresAt: savedPaymentLink.expiresAt,
          },
        },
      });

      response.status(201).json({
        success: true,
        reused: false,
        data: mapPaymentLink(savedPaymentLink),
      });
    } catch (error) {
      console.error("Could not create Razorpay payment link:", error);

      response.status(500).json({
        success: false,
        message: "Could not create a payment link.",
      });
    }
  }
);

app.post(
  "/api/invoices/:invoiceNumber/evaluate-promise",
  async (request, response) => {
    try {
      const { merchantKey, proposedPaymentDate } = request.body;

      if (!merchantKey || !proposedPaymentDate) {
        return response.status(400).json({
          success: false,
          message: "merchantKey and proposedPaymentDate are required.",
        });
      }

      const proposedDate = new Date(`${proposedPaymentDate}T00:00:00`);

      if (Number.isNaN(proposedDate.getTime())) {
        return response.status(400).json({
          success: false,
          message: "proposedPaymentDate must be a valid YYYY-MM-DD date.",
        });
      }

      const invoice = await prisma.invoice.findUnique({
        where: {
          invoiceNumber: request.params.invoiceNumber,
        },
      });

      if (!invoice) {
        return response.status(404).json({
          success: false,
          message: "Invoice not found.",
        });
      }

      const policy = await prisma.recoveryPolicy.findUnique({
        where: {
          merchantKey,
        },
      });

      if (!policy) {
        return response.status(404).json({
          success: false,
          message: "Recovery policy not found.",
        });
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const maximumAllowedDate = addDays(today, policy.maxExtensionDays);

      let decision = "APPROVED";
      let reason = `Payment date is within the merchant limit of ${policy.maxExtensionDays} extension days.`;
      let nextAction = "CREATE_PROMISE_TO_PAY";

      if (proposedDate < today) {
        decision = "ESCALATE";
        reason = "The proposed payment date is in the past.";
        nextAction = "REQUEST_NEW_DATE";
      } else if (proposedDate > maximumAllowedDate) {
        decision = "ESCALATE";
        reason = `The proposed date exceeds the merchant limit of ${policy.maxExtensionDays} extension days.`;
        nextAction = "HUMAN_REVIEW_REQUIRED";
      } else if (
        invoice.daysOverdue >= policy.humanEscalationThresholdDays
      ) {
        decision = "ESCALATE";
        reason = `Invoice is ${invoice.daysOverdue} days overdue, reaching the merchant's human escalation threshold of ${policy.humanEscalationThresholdDays} days.`;
        nextAction = "HUMAN_REVIEW_REQUIRED";
      }

      const result = await prisma.$transaction(async (transaction) => {
        const policyAuditLog = await transaction.auditLog.create({
          data: {
            invoiceId: invoice.id,
            eventType: AuditEventType.POLICY_EVALUATION,
            actorType: "POLICY_ENGINE",
            summary: `${decision}: promise-to-pay proposal for ${formatDateOnly(
              proposedDate
            )}. ${reason}`,
            metadata: {
              merchantKey,
              proposedPaymentDate,
              decision,
              reason,
              nextAction,
              maxExtensionDays: policy.maxExtensionDays,
              humanEscalationThresholdDays:
                policy.humanEscalationThresholdDays,
            },
          },
        });

        if (decision !== "APPROVED") {
          return {
            policyAuditLog,
            promise: null,
            promiseAction: null,
          };
        }

        const activePromise = await transaction.promiseToPay.findFirst({
          where: {
            invoiceId: invoice.id,
            status: PromiseToPayStatus.ACTIVE,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        let promise;
        let promiseAction;
        let promiseAuditEventType;
        let promiseAuditSummary;

        if (activePromise) {
          promise = await transaction.promiseToPay.update({
            where: {
              id: activePromise.id,
            },
            data: {
              promisedAmount: invoice.amount,
              promisedPaymentDate: proposedDate,
              createdBy: "POLICY_ENGINE",
            },
          });

          promiseAction = "UPDATED";
          promiseAuditEventType = AuditEventType.PROMISE_TO_PAY_UPDATED;
          promiseAuditSummary = `Active promise-to-pay updated: ${formatDateOnly(
            proposedDate
          )} for ₹${invoice.amount}.`;
        } else {
          promise = await transaction.promiseToPay.create({
            data: {
              invoiceId: invoice.id,
              promisedAmount: invoice.amount,
              promisedPaymentDate: proposedDate,
              status: PromiseToPayStatus.ACTIVE,
              createdBy: "POLICY_ENGINE",
            },
          });

          promiseAction = "CREATED";
          promiseAuditEventType = AuditEventType.PROMISE_TO_PAY_CREATED;
          promiseAuditSummary = `Promise-to-pay created: ${formatDateOnly(
            proposedDate
          )} for ₹${invoice.amount}.`;
        }

        await transaction.invoice.update({
          where: {
            id: invoice.id,
          },
          data: {
            status: InvoiceStatus.PROMISE_TO_PAY,
          },
        });

        await transaction.auditLog.create({
          data: {
            invoiceId: invoice.id,
            eventType: promiseAuditEventType,
            actorType: "POLICY_ENGINE",
            summary: promiseAuditSummary,
            metadata: {
              promiseId: promise.id,
              promiseAction,
              promisedAmount: promise.promisedAmount,
              promisedPaymentDate: formatDateOnly(
                promise.promisedPaymentDate
              ),
              status: promise.status,
            },
          },
        });

        return {
          policyAuditLog,
          promise,
          promiseAction,
        };
      });

      const updatedInvoice = await prisma.invoice.findUnique({
        where: {
          id: invoice.id,
        },
      });

      await scoreAndRecommendInvoiceIfChanged(updatedInvoice);

      response.json({
        success: true,
        data: {
          invoiceNumber: invoice.invoiceNumber,
          proposedPaymentDate,
          decision,
          reason,
          nextAction,
          policyAuditEventId: result.policyAuditLog.id,
          promiseAction: result.promiseAction,
          promise: result.promise
            ? {
                id: result.promise.id,
                promisedAmount: result.promise.promisedAmount,
                promisedPaymentDate: result.promise.promisedPaymentDate,
                status: result.promise.status,
              }
            : null,
        },
      });
    } catch (error) {
      console.error("Could not evaluate promise-to-pay proposal:", error);

      response.status(500).json({
        success: false,
        message: "Could not evaluate promise-to-pay proposal.",
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Invoice Recovery API is running on http://localhost:${PORT}`);
});
