# Autonomous B2B Invoice Recovery Agent

An agentic B2B receivables-recovery platform built for the Razorpay AI Buildathon — AI Revenue Recovery track.

## Problem

B2B merchants lose cash flow when overdue invoices are chased manually through generic reminders. Small and mid-sized receivables often receive no timely follow-up and can eventually become bad debt.

## Solution

This platform detects overdue invoices, prioritises recovery risk, recommends the next safe action, creates Razorpay Test Mode payment links for eligible cases, interprets customer replies using Gemini structured output, and executes only merchant-policy-bounded workflows.

> The LLM proposes; the policy engine disposes.

## Core capabilities

- PostgreSQL-backed invoice portfolio and recovery dashboard.
- Deterministic urgency score and priority band.
- Next-best-action recommendation engine.
- Merchant recovery policy with extension limits and safety boundaries.
- Promise-to-Pay creation and updates.
- Razorpay Test Mode payment-link creation.
- Verified-recovery workflow architecture with webhook endpoint and development simulator.
- Gemini structured customer-reply interpretation.
- AI-to-policy bridge for safe execution.
- Stopping rules for opt-outs, disputes, discount requests, partial payments, and human escalation.
- Append-only invoice-linked audit trail.

## Architecture

```text
React + Tailwind dashboard
        ↓
Node.js + Express API
        ↓
PostgreSQL + Prisma
        ↓
Deterministic policy / recovery engine
        ↓
Gemini structured reply interpreter
        ↓
Razorpay Test Mode payment links
```

## Safety model

The LLM can interpret customer messages but cannot:

- Approve payment extensions.
- Approve discounts.
- Create financial commitments outside policy.
- Mark payment as recovered.
- Override opt-outs, disputes, or human escalation.

The policy engine validates eligible Promise-to-Pay dates. Disputes, opt-outs, discount requests, partial-payment requests, and human requests stop or escalate automation. Every action is recorded in an invoice audit timeline.

## Local setup

### Prerequisites

- Node.js
- PostgreSQL
- Razorpay Test Mode account
- Gemini API key

### Install frontend

```bash
npm install
npm run dev
```

### Install backend

```bash
cd server
npm install
npx prisma generate
node seed.js
node index.js
```

### Configure secrets

Copy `server/.env.example` to `server/.env` and add your own local credentials.

### Database

Create a PostgreSQL database named:

```text
invoice_recovery_db
```

Then apply migrations:

```bash
cd server
npx prisma migrate dev
node seed.js
```

## Demo scenarios

- Critical invoice → Razorpay payment-link recommendation.
- Customer commits to a date → policy-approved Promise-to-Pay.
- Customer requests an excessive extension → human review.
- Customer requests a discount or partial payment → human review.
- Customer disputes the invoice or opts out → automation stopped.
- Payment recovery → recovered state, audit record, and portfolio metric update.

## Team

Built for Razorpay AI Buildathon.