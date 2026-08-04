# Information Security Policy

**Application:** Life Command — self-hosted personal financial management application
**Owner / Security Contact:** <OWNER NAME>, Owner & Developer — <owner@example.com>
**Version:** 1.0 · **Effective:** 2026-08-04 · **Review cadence:** annually, and on any architectural change

## 1. Purpose and Scope

This policy documents the security controls governing Life Command, a single-operator, self-hosted personal financial management application. The application aggregates the owner's own financial account data (via Plaid) for read-only analysis. It has exactly one user — the owner-developer — who is also the sole data subject. There are no third-party users, no customers, and no data sharing beyond the processors listed in §9.

## 2. Governance

The owner acts as the responsible party for information security: identifying risks, applying the controls in this policy, and remediating gaps (§12). Security requirements are documented in the project specification (Security Requirements, §7) and this policy, and are enforced in code and configuration rather than by convention. This policy is reviewed annually and whenever the architecture changes materially (e.g., migration from local-only to hosted deployment).

## 3. System Overview

All components run on a single owner-controlled workstation: a web dashboard (Next.js), background workers (Node.js), and a PostgreSQL database with auth, storage, and API layers (Supabase local stack in Docker). Financial data enters exclusively through the Plaid API over TLS. No component accepts connections from outside the machine (§5).

## 4. Access Control and Authentication

- **Single allow-listed account.** Public registration is disabled at the authentication server. The sole account is created by an administrative script; a database allow-list (`app_owner`) additionally scopes every table's row-level security to that one user.
- **Multi-factor authentication is mandatory.** Password sign-in must be followed by TOTP verification before any application page or the Plaid Link flow is reachable. Enrollment is forced on first login.
- **Session auto-lock.** The application requires a fresh TOTP challenge when the most recent one exceeds a configurable cadence (default: 60 minutes), including for idle sessions.
- **Step-up re-authentication.** Password changes require a fresh TOTP code in addition to an authenticated session.
- **Least privilege in the data layer.** Row Level Security is enabled on every table; the anonymous role is fully revoked; browser sessions never hold service credentials. Service-role credentials are available only to server-side workers.
- **Third-party consoles.** MFA is required on the accounts used to administer third-party services (Plaid dashboard, model API console).

## 5. Network Security

- Every service binds to loopback only: the web application listens on 127.0.0.1, and the Docker daemon is configured (`ip` and `default-network-opts`) so all containerized services — database, API gateway, admin studio — publish on 127.0.0.1 exclusively. Nothing is reachable from the local network or the internet.
- The host firewall (firewalld) remains enabled; no inbound ports are opened for this application.
- All external API traffic (Plaid; model API) uses HTTPS with TLS 1.2 or better (TLS 1.3 in practice). No consumer data traverses a network in cleartext; browser-to-application traffic never leaves the loopback interface.

## 6. Data Protection and Secrets Management

- API credentials and access tokens live in environment files excluded from version control, readable only by server-side processes. The browser never receives any secret. No credentials are ever committed to the repository.
- Plaid access tokens are encrypted at the application layer before any production (non-sandbox) institution is linked; tokens are revocable per institution from the application.
- Data sent to the model API is limited to derived financial state; account identifiers are masked to last-four, and raw credentials or full account numbers are never included.
- All data resides on the owner's hardware. There is no cloud storage or replication in the current deployment.

## 7. Auditability

An append-only audit log records every material system action (authentication events, configuration changes, data changes by workers, and — in later phases — every recommendation, approval, and execution). Immutability is enforced by database trigger against all roles, including service roles; the application role additionally lacks UPDATE/DELETE grants on the log.

## 8. Change and Vulnerability Management

- All changes are version-controlled (git); the single developer reviews all code and configuration before deployment.
- **Patch SLA:** dependency vulnerabilities surfaced by `npm audit` are remediated on discovery — critical severities within 72 hours; operating-system security updates are applied within 14 days of release (see §12 for planned automation).
- **End-of-life software:** the OS and runtimes are maintained on currently supported releases (Fedora and Node.js current versions); components reaching end-of-life are upgraded or replaced when flagged.

## 9. Third-Party Processors

| Processor | Purpose | Data shared |
|---|---|---|
| Plaid | Account aggregation (read-only) | Institution credentials handled by Plaid Link directly; the application stores only access tokens and returned account data |
| Anthropic | Financial analysis (advisory) | Derived, masked financial state only (§6) |

No data is sold, shared with advertisers, or disclosed to any other party.

## 10. Data Retention and Deletion

Data is retained locally at the owner's discretion. Deletion mechanisms exist at every level: per-institution revocation (removes the Plaid Item and associated access), per-record deletion in the application, and full purge via database reset. As sole data subject, the owner exercises all data-subject rights directly. Unmatched transient artifacts (e.g., email receipts) are archived automatically after 90 days by application rule.

## 11. Incident Response

On suspected compromise, the owner: (1) stops application services and revokes Plaid access tokens from the Plaid dashboard; (2) rotates all API keys and the account password; (3) reviews the append-only audit log to establish scope; (4) remediates before re-linking any institution. Vendor-side fraud flags and anomaly alerts (application watchlist features) provide detection support.

## 12. Known Gaps and Remediation Register

| Gap | Status |
|---|---|
| Full-disk encryption not enabled on the host | Under evaluation (requires OS reinstall); compensating controls: loopback-only exposure, single-occupant premises, MFA-gated application access |
| OS security patching is manual | Planned: enable automatic security-update timer |
| Plaid access-token application-layer encryption | Scheduled; enforced before the first production institution is linked |

The owner attests to remediating any additional gaps identified by Plaid's security review.

## 13. Review

This policy is reviewed at least annually and upon material architectural change (notably the planned migration to hosted infrastructure, which will move secrets to a managed vault and re-evaluate §5–6 controls).

— *<OWNER NAME>, Owner & Developer — effective 2026-08-04*
