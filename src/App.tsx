import { FormEvent, useEffect, useState } from "react";
import "./App.css";

type Invoice = {
  id: string;
  invoiceNumber: string;
  customer: string;
  amount: number;
  daysOverdue: number;
  status: "High Priority" | "Follow Up Due" | "Promise To Pay" | "Recovered";
  urgencyScore: number;
  urgencyBand: "Low" | "Medium" | "High" | "Critical";
  recommendedAction: string;
  actionReason: string;
};

type AuditLog = {
  id: string;
  eventType: string;
  actorType: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type PromiseToPay = {
  id: string;
  promisedAmount: number;
  promisedPaymentDate: string;
  status: "ACTIVE" | "KEPT" | "BROKEN" | "CANCELLED";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type PaymentLink = {
  id: string;
  razorpayLinkId: string;
  shortUrl: string;
  status: string;
  razorpayPaymentId: string | null;
  paidAt: string | null;
  amount: number;
  currency: string;
  referenceId: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type InvoiceDetail = Invoice & {
  createdAt: string;
  updatedAt: string;
  promisesToPay: PromiseToPay[];
  paymentLinks: PaymentLink[];
  auditLogs: AuditLog[];
};

type InvoicesApiResponse = {
  success: boolean;
  count: number;
  data: Invoice[];
};

type InvoiceDetailApiResponse = {
  success: boolean;
  data: InvoiceDetail;
};

type PromiseEvaluation = {
  invoiceNumber: string;
  proposedPaymentDate: string;
  decision: "APPROVED" | "ESCALATE";
  reason: string;
  nextAction: string;
  policyAuditEventId: string;
  promiseAction: "CREATED" | "UPDATED" | null;
  promise: {
    id: string;
    promisedAmount: number;
    promisedPaymentDate: string;
    status: string;
  } | null;
};

type PromiseEvaluationApiResponse = {
  success: boolean;
  data: PromiseEvaluation;
};

type CustomerReplyInterpretation = {
  intent: string;
  proposedPaymentDate: string | null;
  requestedDiscountPercent: number | null;
  requestedPartialAmount: number | null;
  disputeDetected: boolean;
  optOutDetected: boolean;
  reason: string | null;
  confidence: number;
};

type CustomerReplyInterpretationApiResponse = {
  success: boolean;
  data: CustomerReplyInterpretation;
};

type AiExecutionResult = {
  outcome: string;
  message?: string;
  decision?: string;
  reason?: string;
  nextAction?: string;
  promiseAction?: string | null;
};

type AiExecutionApiResponse = {
  success: boolean;
  data: AiExecutionResult;
};

type DashboardMetrics = {
  totalPortfolioAmount: number;
  recoveredAmount: number;
  activePipelineAmount: number;
  promiseToPayAmount: number;
  recoveryRate: number;
  humanReviewCount: number;
  optedOutCount: number;
  recoveredCount: number;
  activePipelineCount: number;
};

type DashboardMetricsApiResponse = {
  success: boolean;
  data: DashboardMetrics;
};

type RecoveryException = {
  id: string;
  invoiceNumber: string;
  customer: string;
  amount: number;
  daysOverdue: number;
  status: "Human Review" | "Opted Out";
  urgencyScore: number;
  urgencyBand: "Low" | "Medium" | "High" | "Critical";
  recommendedAction: string;
  actionReason: string;
  updatedAt: string;
};

type RecoveryExceptionsApiResponse = {
  success: boolean;
  count: number;
  data: RecoveryException[];
};

const merchantKey = "merchant_demo_01";
const conversationPresets = [
  {
    id: "promise-to-pay",
    label: "Promise to pay",
    message:
      "We are facing a short cash-flow delay, but we can pay the full outstanding amount by 10 September 2026.",
  },
  {
    id: "discount-request",
    label: "Discount request",
    message:
      "We can settle the invoice this week only if you provide a 5 percent discount.",
  },
  {
    id: "dispute-opt-out",
    label: "Dispute & opt-out",
    message:
      "This invoice is incorrect. Stop all automated payment reminders and arrange a call with a human from your finance team.",
  },
  {
    id: "pay-now",
    label: "Pay now",
    message:
      "We are ready to settle this invoice today. Please share a secure payment link.",
  },
];

const formatINR = (amount: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);

const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
  
const formatDateOnly = (value: string) =>
  new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
  }).format(new Date(value));  

const formatNextAction = (value: string) =>
  value
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");

const statusClassName = (status: string) =>
  status.toLowerCase().replaceAll(" ", "-");
const urgencyClassName = (band: string) =>
  `urgency-${band.toLowerCase()}`;

function App() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoadingInvoices, setIsLoadingInvoices] = useState(true);
  const [invoiceError, setInvoiceError] = useState("");

  const [metrics, setMetrics] = useState<DashboardMetrics>({
    totalPortfolioAmount: 0,
    recoveredAmount: 0,
    activePipelineAmount: 0,
    promiseToPayAmount: 0,
    recoveryRate: 0,
    humanReviewCount: 0,
    optedOutCount: 0,
    recoveredCount: 0,
    activePipelineCount: 0,
  });

  const [recoveryExceptions, setRecoveryExceptions] = useState<
    RecoveryException[]
  >([]);

  const [selectedInvoiceNumber, setSelectedInvoiceNumber] = useState<
    string | null
  >(null);
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceDetail | null>(
    null
  );
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");

  const [proposedPaymentDate, setProposedPaymentDate] = useState("");
  const [isEvaluatingPromise, setIsEvaluatingPromise] = useState(false);
  const [evaluationError, setEvaluationError] = useState("");
  const [evaluationResult, setEvaluationResult] =
    useState<PromiseEvaluation | null>(null);
  const [isCreatingPaymentLink, setIsCreatingPaymentLink] = useState(false);
  const [paymentLinkError, setPaymentLinkError] = useState("");
  const [customerMessage, setCustomerMessage] = useState("");
  const [isInterpretingReply, setIsInterpretingReply] = useState(false);
  const [interpretationError, setInterpretationError] = useState("");
  const [replyInterpretation, setReplyInterpretation] =
    useState<CustomerReplyInterpretation | null>(null);

  const [isExecutingAiAction, setIsExecutingAiAction] = useState(false);
  const [aiExecutionError, setAiExecutionError] = useState("");
  const [aiExecutionResult, setAiExecutionResult] =
    useState<AiExecutionResult | null>(null);

  const [isSimulatingPayment, setIsSimulatingPayment] = useState(false);
  const [simulationMessage, setSimulationMessage] = useState("");

  const activePromise =
    selectedInvoice?.promisesToPay.find(
      (promise) => promise.status === "ACTIVE"
    ) ?? null;
  const latestPaymentLink = selectedInvoice?.paymentLinks[0] ?? null;


  async function fetchInvoiceDetail(invoiceNumber: string) {
    const response = await fetch(
      `/api/invoices/${encodeURIComponent(invoiceNumber)}`
    );

    if (!response.ok) {
      throw new Error("Could not load the invoice recovery case.");
    }

    const result: InvoiceDetailApiResponse = await response.json();

    if (!result.success) {
      throw new Error("The API returned an unsuccessful response.");
    }

    return result.data;
  }

  async function loadMetrics() {
    try {
      const response = await fetch("/api/metrics");

      if (!response.ok) {
        throw new Error("Could not load dashboard metrics.");
      }

      const result: DashboardMetricsApiResponse = await response.json();

      if (result.success) {
        setMetrics(result.data);
      }
    } catch (error) {
      console.error("Could not load metrics:", error);
    }
  }
    async function loadRecoveryExceptions() {
    try {
      const response = await fetch("/api/recovery-exceptions");

      if (!response.ok) {
        throw new Error("Could not load recovery exceptions.");
      }

      const result: RecoveryExceptionsApiResponse = await response.json();

      if (result.success) {
        setRecoveryExceptions(result.data);
      }
    } catch (error) {
      console.error("Could not load recovery exceptions:", error);
    }
  }

  useEffect(() => {
    async function loadInvoices() {
      try {
        const response = await fetch("/api/invoices");

        if (!response.ok) {
          throw new Error("Could not load invoices from the API.");
        }

        const result: InvoicesApiResponse = await response.json();

        if (!result.success) {
          throw new Error("The API returned an unsuccessful response.");
        }

        setInvoices(result.data);
      } catch (error) {
        setInvoiceError(
          error instanceof Error
            ? error.message
            : "An unknown error occurred while loading invoices."
        );
      } finally {
        setIsLoadingInvoices(false);
      }
    }

    loadInvoices();
    loadMetrics();
    loadRecoveryExceptions();
    }, []);

  useEffect(() => {
    if (!selectedInvoiceNumber) {
      setSelectedInvoice(null);
      setDetailError("");
      setProposedPaymentDate("");
      setEvaluationError("");
      setEvaluationResult(null);
      return;
    }

    async function loadInvoiceDetail() {
      setIsLoadingDetail(true);
      setDetailError("");
      setProposedPaymentDate("");
      setEvaluationError("");
      setEvaluationResult(null);

      try {
        const invoiceDetail = await fetchInvoiceDetail(selectedInvoiceNumber);
        setSelectedInvoice(invoiceDetail);
      } catch (error) {
        setDetailError(
          error instanceof Error
            ? error.message
            : "An unknown error occurred while loading the invoice detail."
        );
      } finally {
        setIsLoadingDetail(false);
      }
    }

    loadInvoiceDetail();
  }, [selectedInvoiceNumber]);

  async function handlePromiseEvaluation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedInvoice) {
      return;
    }

    if (!proposedPaymentDate) {
      setEvaluationError("Please select a proposed payment date.");
      return;
    }

    setIsEvaluatingPromise(true);
    setEvaluationError("");
    setEvaluationResult(null);

    try {
      const response = await fetch(
        `/api/invoices/${encodeURIComponent(
          selectedInvoice.invoiceNumber
        )}/evaluate-promise`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            merchantKey,
            proposedPaymentDate,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(
          result.message ?? "Could not evaluate the promise-to-pay request."
        );
      }

      setEvaluationResult(result.data);

      const refreshedInvoice = await fetchInvoiceDetail(
        selectedInvoice.invoiceNumber
      );
      setSelectedInvoice(refreshedInvoice);
    } catch (error) {
      setEvaluationError(
        error instanceof Error
          ? error.message
          : "An unknown error occurred while evaluating the payment date."
      );
    } finally {
      setIsEvaluatingPromise(false);
    }
  }

  async function handleInterpretCustomerReply(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (!selectedInvoice || !customerMessage.trim()) {
      setInterpretationError("Enter a customer reply before interpreting it.");
      return;
    }

    setIsInterpretingReply(true);
    setInterpretationError("");
    setReplyInterpretation(null);
    setAiExecutionError("");
    setAiExecutionResult(null);


    try {
      const response = await fetch(
        `/api/invoices/${encodeURIComponent(
          selectedInvoice.invoiceNumber
        )}/interpret-reply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            customerMessage: customerMessage.trim(),
          }),
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(
          result.message ?? "Could not interpret the customer reply."
        );
      }

      setReplyInterpretation(result.data);

      const refreshedInvoice = await fetchInvoiceDetail(
        selectedInvoice.invoiceNumber
      );

      setSelectedInvoice(refreshedInvoice);
    } catch (error) {
      setInterpretationError(
        error instanceof Error
          ? error.message
          : "An unknown error occurred while interpreting the reply."
      );
    } finally {
      setIsInterpretingReply(false);
    }
  }

  async function handleExecuteAiInterpretation() {
    if (!selectedInvoice || !replyInterpretation) {
      return;
    }

    setIsExecutingAiAction(true);
    setAiExecutionError("");
    setAiExecutionResult(null);

    try {
      const response = await fetch(
        `/api/invoices/${encodeURIComponent(
          selectedInvoice.invoiceNumber
        )}/execute-ai-interpretation`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            interpretation: replyInterpretation,
          }),
        }
      );

      const result: AiExecutionApiResponse = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(
          "message" in result
            ? String(result.message)
            : "Could not execute the AI interpretation safely."
        );
      }

      setAiExecutionResult(result.data);

      const refreshedInvoice = await fetchInvoiceDetail(
        selectedInvoice.invoiceNumber
      );

      setSelectedInvoice(refreshedInvoice);
      await loadMetrics();
      await loadRecoveryExceptions();
    } catch (error) {
      setAiExecutionError(
        error instanceof Error
          ? error.message
          : "An unknown error occurred while applying the safe action."
      );
    } finally {
      setIsExecutingAiAction(false);
    }
  }

  async function handleCreatePaymentLink() {
    if (!selectedInvoice) {
      return;
    }

    setIsCreatingPaymentLink(true);
    setPaymentLinkError("");

    try {
      const response = await fetch(
        `/api/invoices/${encodeURIComponent(
          selectedInvoice.invoiceNumber
        )}/payment-links`,
        {
          method: "POST",
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(
          result.message ?? "Could not create the Razorpay payment link."
        );
      }

      const refreshedInvoice = await fetchInvoiceDetail(
        selectedInvoice.invoiceNumber
      );

      setSelectedInvoice(refreshedInvoice);
    } catch (error) {
      setPaymentLinkError(
        error instanceof Error
          ? error.message
          : "An unknown error occurred while creating the payment link."
      );
    } finally {
      setIsCreatingPaymentLink(false);
    }
  }

  async function handleSimulatePayment() {
    if (!latestPaymentLink || !selectedInvoice) {
      return;
    }

    setIsSimulatingPayment(true);
    setPaymentLinkError("");
    setSimulationMessage("");

    try {
      const response = await fetch(
        `/api/dev/payment-links/${encodeURIComponent(
          latestPaymentLink.razorpayLinkId
        )}/mark-paid`,
        {
          method: "POST",
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(
          result.message ?? "Could not simulate the verified payment."
        );
      }

      setSimulationMessage(result.message);

      const refreshedInvoice = await fetchInvoiceDetail(
        selectedInvoice.invoiceNumber
      );

      setSelectedInvoice(refreshedInvoice);
      await loadMetrics();
    } catch (error) {
      setPaymentLinkError(
        error instanceof Error
          ? error.message
          : "An unknown error occurred while simulating payment."
      );
    } finally {
      setIsSimulatingPayment(false);
    }
  }

  if (selectedInvoiceNumber) {
    return (
      <main className="dashboard">
        <button
          className="back-button"
          type="button"
          onClick={() => {
            setSelectedInvoiceNumber(null);
            loadMetrics();
            loadRecoveryExceptions();
          }}

        >
          ← Back to dashboard
        </button>

        {isLoadingDetail && (
          <section className="panel detail-loading">
            <p className="api-message">Loading recovery case from the API…</p>
          </section>
        )}

        {detailError && (
          <section className="panel detail-loading">
            <p className="api-message error-message">API error: {detailError}</p>
          </section>
        )}

        {selectedInvoice && !isLoadingDetail && !detailError && (
          <>
            <header className="detail-hero">
              <div>
                <p className="eyebrow">INVOICE RECOVERY CASE</p>
                <h1>{selectedInvoice.invoiceNumber}</h1>
                <p className="subtitle">{selectedInvoice.customer}</p>
              </div>

              <span
                className={`badge large-badge ${statusClassName(
                  selectedInvoice.status
                )}`}
              >
                {selectedInvoice.status}
              </span>
            </header>

            <section className="detail-metric-grid">
              <article className="metric-card">
                <p>Outstanding amount</p>
                <h2>{formatINR(selectedInvoice.amount)}</h2>
                <span>Awaiting recovery</span>
              </article>

              <article className="metric-card">
                <p>Days overdue</p>
                <h2>{selectedInvoice.daysOverdue}</h2>
                <span className="warning">Collection urgency indicator</span>
              </article>

              <article className="metric-card">
                <p>Recovery urgency</p>
                <h2>{selectedInvoice.urgencyScore}/100</h2>
                <span
                  className={`urgency-text ${urgencyClassName(
                    selectedInvoice.urgencyBand
                  )}`}
                >
                  {selectedInvoice.urgencyBand} priority
                </span>
              </article>

              <article className="metric-card">
                <p>Audit events</p>
                <h2>{selectedInvoice.auditLogs.length}</h2>
                <span className="positive">Append-only timeline</span>
              </article>
            </section>            {activePromise && (
              <section className="active-promise-card">
                <div>
                  <p className="eyebrow">ACTIVE CUSTOMER COMMITMENT</p>
                  <h2>Promise-to-pay recorded</h2>
                  <p>
                    The customer has committed to settle this invoice on{" "}
                    <strong>
                      {formatDateOnly(activePromise.promisedPaymentDate)}
                    </strong>
                    .
                  </p>
                </div>

                <div className="promise-amount">
                  <span>Promised amount</span>
                  <strong>{formatINR(activePromise.promisedAmount)}</strong>
                  <small>Created by {activePromise.createdBy}</small>
                </div>
              </section>
            )}

            <section className="next-action-card">
              <div>
                <p className="eyebrow">NEXT BEST ACTION</p>
                <h2>{selectedInvoice.recommendedAction}</h2>
                <p>{selectedInvoice.actionReason}</p>
              </div>

              <span
                className={`urgency-badge large-urgency-badge ${urgencyClassName(
                  selectedInvoice.urgencyBand
                )}`}
              >
                {selectedInvoice.urgencyBand} urgency
              </span>
            </section>

            {(selectedInvoice.recommendedAction === "Send Payment Link" ||
              selectedInvoice.status === "Recovered") && (
              <section className="payment-link-card">
                <div>
                  <p className="eyebrow">RAZORPAY TEST MODE</p>
                  <h2>
                    {selectedInvoice.status === "Recovered"
                      ? "Payment recovered"
                      : "Secure payment link"}
                  </h2>

                  {selectedInvoice.status === "Recovered" &&
                  latestPaymentLink?.paidAt ? (
                    <>
                      <p>
                        Razorpay confirmed this payment. Recovery automation has
                        stopped and the invoice is now marked as recovered.
                      </p>
                      <small>
                        Payment ID: {latestPaymentLink.razorpayPaymentId} ·
                        Confirmed {formatDateTime(latestPaymentLink.paidAt)}
                      </small>
                    </>
                  ) : latestPaymentLink ? (
                    <>
                      <p>
                        A secure Razorpay payment link has been created for this
                        recovery case.
                      </p>
                      <a
                        className="open-payment-link"
                        href={latestPaymentLink.shortUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open secure payment link ↗
                      </a>
                      <button
                        className="simulate-payment-button"
                        type="button"
                        onClick={handleSimulatePayment}
                        disabled={isSimulatingPayment}
                      >
                        {isSimulatingPayment
                          ? "Simulating verified payment…"
                          : "Demo: simulate Razorpay payment_link.paid webhook"}
                      </button>
                      <small>
                        Link status: {latestPaymentLink.status} · Expires{" "}
                        {latestPaymentLink.expiresAt
                          ? formatDateTime(latestPaymentLink.expiresAt)
                          : "not specified"}
                      </small>
                    </>
                  ) : (
                    <>
                      <p>
                        This critical case is eligible for a Razorpay payment
                        link. Create one only after confirming the recovery
                        recommendation.
                      </p>

                      <button
                        className="create-payment-link-button"
                        type="button"
                        onClick={handleCreatePaymentLink}
                        disabled={isCreatingPaymentLink}
                      >
                        {isCreatingPaymentLink
                          ? "Creating Razorpay link…"
                          : "Create Razorpay payment link"}
                      </button>
                    </>
                  )}

                  {simulationMessage && (
                    <p className="simulation-message">{simulationMessage}</p>
                  )}

                  {paymentLinkError && (
                    <p className="form-message error-message">
                      {paymentLinkError}
                    </p>
                  )}
                </div>

                <div className="payment-link-amount">
                  <span>
                    {selectedInvoice.status === "Recovered"
                      ? "Recovered amount"
                      : "Amount to collect"}
                  </span>
                  <strong>{formatINR(selectedInvoice.amount)}</strong>
                  <small>
                    {selectedInvoice.status === "Recovered"
                      ? "Verified through Razorpay webhook."
                      : "Payment is confirmed by webhook."}
                  </small>
                </div>
              </section>
            )}

            <section className="ai-reply-card">
              <div>
                <p className="eyebrow">AI CUSTOMER REPLY INTERPRETER</p>
                <h2>Interpret customer response</h2>
                <p>
                  Analyzes customer responses to identify payment intent, proposed commitment dates, disputes, opt-out requests, and escalation signals. All financial decisions are validated against merchant-defined recovery policy before any action is taken.
                </p>

                <form
                  className="customer-reply-form"
                  onSubmit={handleInterpretCustomerReply}
                >
                  <label htmlFor="customerMessage">Customer message</label>
                    <div className="preset-section">
                      <span>Demo scenarios</span>

                      <div className="preset-buttons">
                        {conversationPresets.map((preset) => (
                          <button
                            className="preset-button"
                            key={preset.id}
                            type="button"
                            onClick={() => {
                              setCustomerMessage(preset.message);
                              setInterpretationError("");
                              setReplyInterpretation(null);
                              setAiExecutionError("");
                              setAiExecutionResult(null);
                            }}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                  <textarea
                    id="customerMessage"
                    value={customerMessage}
                    onChange={(event) => setCustomerMessage(event.target.value)}
                    placeholder="Example: We can pay the full amount next Friday. Please share a payment link."
                    rows={4}
                  />

                  <button type="submit" disabled={isInterpretingReply}>
                    {isInterpretingReply
                      ? "Interpreting reply…"
                      : "Interpret with AI"}
                  </button>
                </form>

                {interpretationError && (
                  <p className="form-message error-message">
                    {interpretationError}
                  </p>
                )}
              </div>

              {replyInterpretation && (
                <div className="interpretation-result">
                  <p className="result-label">Structured interpretation</p>
                  <h3>{formatNextAction(replyInterpretation.intent)}</h3>

                  <div className="interpretation-grid">
                    <span>Promise date</span>
                    <strong>
                      {replyInterpretation.proposedPaymentDate ?? "Not provided"}
                    </strong>

                    <span>Discount request</span>
                    <strong>
                      {replyInterpretation.requestedDiscountPercent !== null
                        ? `${replyInterpretation.requestedDiscountPercent}%`
                        : "None"}
                    </strong>

                    <span>Partial payment</span>
                    <strong>
                      {replyInterpretation.requestedPartialAmount !== null
                        ? formatINR(replyInterpretation.requestedPartialAmount)
                        : "None"}
                    </strong>

                    <span>Safety signals</span>
                    <strong>
                      {replyInterpretation.disputeDetected ||
                      replyInterpretation.optOutDetected
                        ? "Stop automation / human review"
                        : "No stop signal"}
                    </strong>

                    <span>Confidence</span>
                    <strong>
                      {Math.round(replyInterpretation.confidence * 100)}%
                    </strong>
                  </div>

                  {replyInterpretation.reason && (
                    <p className="interpretation-reason">
                      {replyInterpretation.reason}
                    </p>
                  )}
                                    <button
                    className="apply-ai-action-button"
                    type="button"
                    onClick={handleExecuteAiInterpretation}
                    disabled={isExecutingAiAction}
                  >
                    {isExecutingAiAction
                      ? "Applying safety rules…"
                      : "Apply safe workflow action"}
                  </button>

                  {aiExecutionError && (
                    <p className="form-message error-message">
                      {aiExecutionError}
                    </p>
                  )}

                  {aiExecutionResult && (
                    <div className="ai-execution-result">
                      <span>Workflow outcome</span>
                      <strong>
                        {formatNextAction(aiExecutionResult.outcome)}
                      </strong>
                      <p>
                        {aiExecutionResult.message ??
                          aiExecutionResult.reason ??
                          "Policy-controlled action completed."}
                      </p>
                    </div>
                  )}
          
                </div>
              )}
            </section>
            
            <section className="detail-grid">
            
              <article className="panel">
                <p className="eyebrow">RECOVERY SUMMARY</p>
                <h2>Case status</h2>

                <div className="case-summary">
                  <div>
                    <span>Customer</span>
                    <strong>{selectedInvoice.customer}</strong>
                  </div>
                  <div>
                    <span>Invoice created</span>
                    <strong>{formatDateTime(selectedInvoice.createdAt)}</strong>
                  </div>
                  <div>
                    <span>Last updated</span>
                    <strong>{formatDateTime(selectedInvoice.updatedAt)}</strong>
                  </div>
                  <div>
                    <span>Next action</span>
                    <strong>
                      {activePromise
                        ? `Await payment by ${formatDateOnly(
                            activePromise.promisedPaymentDate
                          )}`
                        : "Policy evaluation available"}
                    </strong>
                  </div>
                </div>

                <p className="policy-note">
                  <strong>Control principle:</strong> The LLM proposes; the
                  policy engine disposes. This case can only accept a
                  promise-to-pay date within the merchant’s safety limits.
                </p>
              </article>

              <article className="panel promise-panel">
                <p className="eyebrow">SAFE NEGOTIATION CHECK</p>
                <h2>Evaluate promise-to-pay</h2>

                <p className="form-description">
                  Submit a customer’s proposed payment date. The policy engine
                  decides whether the date is allowed or needs human review.
                </p>

                <form className="promise-form" onSubmit={handlePromiseEvaluation}>
                  <label htmlFor="proposedPaymentDate">
                    Proposed payment date
                  </label>

                  <input
                    id="proposedPaymentDate"
                    type="date"
                    value={proposedPaymentDate}
                    onChange={(event) =>
                      setProposedPaymentDate(event.target.value)
                    }
                    required
                  />

                  <button
                    className="evaluate-button"
                    type="submit"
                    disabled={isEvaluatingPromise}
                  >
                    {isEvaluatingPromise
                      ? "Evaluating policy…"
                      : "Evaluate policy"}
                  </button>
                </form>

                {evaluationError && (
                  <p className="form-message error-message">
                    {evaluationError}
                  </p>
                )}

                {evaluationResult && (
                  <div
                    className={`evaluation-result ${
                      evaluationResult.decision === "APPROVED"
                        ? "decision-approved"
                        : "decision-escalate"
                    }`}
                  >
                    <p className="result-label">Policy decision</p>
                    <h3>{evaluationResult.decision}</h3>
                    <p>{evaluationResult.reason}</p>

                    <div className="result-details">
                      <span>Proposed date</span>
                      <strong>{evaluationResult.proposedPaymentDate}</strong>

                      <span>Next action</span>
                      <strong>
                        {formatNextAction(evaluationResult.nextAction)}
                      </strong>

                      <span>Promise record</span>
                      <strong>
                        {evaluationResult.promiseAction
                          ? `Promise ${evaluationResult.promiseAction.toLowerCase()}`
                          : "Not created"}
                      </strong>

                      <span>Audit record</span>
                      <strong>Created successfully</strong>
                    </div>
                  </div>
                )}
              </article>
            </section>

            <section className="panel timeline-panel">
              <p className="eyebrow">AUDIT TRAIL</p>
              <h2>Case timeline</h2>

              <div className="timeline">
                {selectedInvoice.auditLogs.map((auditLog) => (
                  <div className="timeline-event" key={auditLog.id}>
                    <span className="timeline-dot" />
                    <div>
                      <div className="timeline-heading">
                        <strong>{auditLog.eventType.replaceAll("_", " ")}</strong>
                        <span>{formatDateTime(auditLog.createdAt)}</span>
                      </div>
                      <p>{auditLog.summary}</p>
                      <small>Actor: {auditLog.actorType}</small>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    );
  }

  return (
    <main className="dashboard">
      <header className="hero">
        <div>
          <p className="eyebrow">RAZORPAY AI BUILDATHON · AI REVENUE RECOVERY</p>
          <h1>Autonomous B2B Invoice Recovery Agent</h1>
          <p className="subtitle">
            A policy-bound AI collections desk for overdue B2B invoices.
          </p>
        </div>

        <div className="agent-status">
          <span className="status-dot" />
          Agent monitoring active
        </div>
      </header>

    <section className="metric-grid">
      <article className="metric-card">
        <p>Verified money recovered</p>
        <h2>{formatINR(metrics.recoveredAmount)}</h2>
        <span className="positive">
          {metrics.recoveredCount} webhook-confirmed / demo-confirmed recoveries
        </span>
      </article>

      <article className="metric-card">
        <p>Active recovery pipeline</p>
        <h2>{formatINR(metrics.activePipelineAmount)}</h2>
        <span>{metrics.activePipelineCount} invoices still under recovery</span>
      </article>

      <article className="metric-card">
        <p>Recovery rate</p>
        <h2>{metrics.recoveryRate}%</h2>
        <span>
          {formatINR(metrics.recoveredAmount)} recovered from{" "}
          {formatINR(metrics.totalPortfolioAmount)} portfolio value
        </span>
      </article>

      <article className="metric-card">
        <p>Active Promise-to-Pay</p>
        <h2>{formatINR(metrics.promiseToPayAmount)}</h2>
        <span className="positive">Customer commitments being monitored</span>
      </article>
  </section>

  <section className="metric-grid secondary-metric-grid">
    <article className="metric-card compact-metric">
      <p>Human review queue</p>
      <h2>{metrics.humanReviewCount}</h2>
      <span className="warning">Disputes, discounts, partial payments</span>
    </article>

    <article className="metric-card compact-metric">
      <p>Automation stopped</p>
      <h2>{metrics.optedOutCount}</h2>
      <span className="positive">Customer opt-outs respected</span>
    </article>

    <article className="metric-card compact-metric">
      <p>Total portfolio at risk</p>
      <h2>{formatINR(metrics.totalPortfolioAmount)}</h2>
      <span>All seeded receivables in this batch</span>
    </article>
  </section>

      <section className="content-grid">
        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">LIVE RECOVERY QUEUE</p>
              <h2>Overdue invoices</h2>
            </div>
            <button type="button">View all cases</button>
          </div>

          {isLoadingInvoices && (
            <p className="api-message">Loading overdue invoices from the API…</p>
          )}

          {invoiceError && (
            <p className="api-message error-message">
              API error: {invoiceError}
            </p>
          )}

          {!isLoadingInvoices && !invoiceError && (
            <div className="invoice-list">
              {invoices.map((invoice) => (
                <button
                  className="invoice-row invoice-button"
                  key={invoice.invoiceNumber}
                  type="button"
                  onClick={() => setSelectedInvoiceNumber(invoice.invoiceNumber)}
                >
                  <div>
                    <strong>{invoice.customer}</strong>
                    <p>{invoice.invoiceNumber}</p>
                  </div>

                  <div>
                    <strong>{formatINR(invoice.amount)}</strong>
                    <p>{invoice.daysOverdue} days overdue</p>
                  </div>

                  <div className="urgency-cell">
                    <strong>{invoice.urgencyScore}/100</strong>
                    <span className={`urgency-badge ${urgencyClassName(invoice.urgencyBand)}`}>
                      {invoice.urgencyBand}
                    </span>
                  </div>
                  <div className="action-cell">
                    <span>Next action</span>
                    <strong>{invoice.recommendedAction}</strong>
                  </div>

                  <span className={`badge ${statusClassName(invoice.status)}`}>
                    {invoice.status}
                  </span>
                </button>
              ))}
            </div>
          )}
        </article>

        <aside className="panel pipeline-panel">
          <p className="eyebrow">RECOVERY PIPELINE</p>
          <h2>Money under recovery</h2>

          <div className="pipeline-step">
            <span>At risk</span>
            <strong>₹28.7L</strong>
          </div>
          <div className="pipeline-step">
            <span>Contacted</span>
            <strong>₹18.2L</strong>
          </div>
          <div className="pipeline-step">
            <span>Promise to pay</span>
            <strong>₹9.4L</strong>
          </div>
          <div className="pipeline-step">
            <span>Recovered</span>
            <strong className="positive">₹12.45L</strong>
          </div>

          <p className="policy-note">
            <strong>Safety principle:</strong> The LLM proposes; the policy
            engine disposes.
          </p>
        </aside>
      </section>
            <section className="panel exceptions-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">COMPLIANT ESCALATION</p>
            <h2>Human review & stopped automation</h2>
          </div>
          <span className="exception-count">
            {recoveryExceptions.length} exception
            {recoveryExceptions.length === 1 ? "" : "s"}
          </span>
        </div>

        {recoveryExceptions.length === 0 ? (
          <p className="empty-exceptions">
            No cases currently require human review or have opted out of
            automated recovery.
          </p>
        ) : (
          <div className="exception-list">
            {recoveryExceptions.map((exception) => (
              <button
                className="exception-row"
                key={exception.invoiceNumber}
                type="button"
                onClick={() =>
                  setSelectedInvoiceNumber(exception.invoiceNumber)
                }
              >
                <div>
                  <strong>{exception.customer}</strong>
                  <p>{exception.invoiceNumber}</p>
                </div>

                <div>
                  <strong>{formatINR(exception.amount)}</strong>
                  <p>{exception.daysOverdue} days overdue</p>
                </div>

                <div className="exception-reason">
                  <strong>{exception.status}</strong>
                  <p>{exception.actionReason}</p>
                </div>

                <span
                  className={`badge ${statusClassName(exception.status)}`}
                >
                  {exception.status}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;