# Data Retention and Disposal Policy

**Application:** Life Command — self-hosted personal financial management application
**Owner / Contact:** <OWNER NAME>, Owner & Developer — <owner@example.com>
**Version:** 1.0 · **Effective:** 2026-08-04 · **Review cadence:** annually, alongside the Information Security Policy

## 1. Purpose and Scope

This policy defines how data held by Life Command is retained and disposed of. The application is operated by a single individual who is also the sole data subject: all financial data in the system belongs to the operator personally. No customer or third-party consumer data is collected or stored.

## 2. Retention Schedule

| Data category | Retention | Disposal trigger |
|---|---|---|
| Financial account data from Plaid (accounts, balances, transactions, holdings, liabilities) | While the institution link is active and the data remains useful for the owner's personal financial analysis | Institution unlink, per-record deletion, or full purge — at owner discretion |
| Plaid access tokens | While the institution is linked | Destroyed immediately upon unlink/revocation |
| Receipts and attached documents | Life of the linked transaction record | Deleted with the transaction, or individually |
| Unmatched email-receipt artifacts | 90 days awaiting transaction matching | Automatically archived by application rule after 90 days |
| Audit log (append-only integrity record) | Life of the system | Destroyed only with full system disposal |
| Authentication data (single account) | Life of the account | Removed on account deletion |
| Backups (when introduced) | Same retention as source data; encrypted | Rotated and destroyed on schedule |

## 3. Disposal Methods

- **Per-institution:** revocation removes the Plaid Item and destroys the stored access token; associated data is deletable at owner discretion.
- **Per-record:** individual records (transactions, receipts, entries) are deletable through the application and database tooling.
- **Full disposal:** a database reset purges all application data; Docker volumes hold no copies outside the owner's machine.
- **Physical media:** storage devices are securely wiped before repurposing or disposal of hardware.

## 4. Compliance Posture

The sole data subject is the owner-operator, who exercises all data-subject rights (access, correction, deletion) directly and immediately. Because no other individual's data is collected, processed, or stored, obligations owed to third-party consumers under applicable privacy laws do not arise; the policy nonetheless follows their core principles — data minimization, purpose limitation, and deletion on request.

## 5. Enforcement and Review

Time-based rules (e.g., the 90-day receipt archival) are enforced automatically by the application. All other disposal is executed by the owner using the mechanisms in §3. This policy is reviewed at least annually and upon material architectural change (notably any migration from local-only to hosted infrastructure).

— *<OWNER NAME>, Owner & Developer — effective 2026-08-04*
