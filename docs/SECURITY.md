# Security architecture

How sign-in works and what personal data the system holds. Written for STORY-012
and REQ-010. Everything here describes what is built today; the gaps are listed.

## Not met yet

- **Active Directory.** REQ-010 asks for the City's Windows Active Directory, with
  single sign-on. This project cannot reach a directory, so accounts are local and
  there is no single sign-on. `verifyPassword` in `server/auth.js` is the one place
  a directory would plug in. Real AD integration still needs the City's connection
  details, and a decision between LDAP and federation (ADFS or Entra ID).
- **No security review.** This has not been penetration tested or reviewed by the
  City's security staff.

## Signing in

1. **Password.** Checked against a salted scrypt hash. The answer is the same whether
   or not the user exists, and takes about as long.
2. **Authenticator code.** A 6-digit TOTP code (RFC 6238), required for every account.
   A code cannot be used twice. A challenge lasts 5 minutes, allows 5 tries, and must
   be finished from the same IP address and browser that gave the password.
3. **Session.** A random token in an `HttpOnly`, `SameSite=Strict` cookie, marked
   `Secure` behind a TLS proxy. Only its hash is stored.

## Protections

| Threat | Response |
|---|---|
| Wrong password or code | Denied, recorded, alert logged |
| Guessing | Locked after 5 failures in 15 minutes per user and address, 20 per user, 50 per address. An alert is logged once. Bursts sent in parallel are counted too. |
| Stolen session | A session used from a different IP address or browser is ended and alerted |
| Forgotten session | Ends after 30 idle minutes, or 8 hours regardless |
| Another site acting for a signed-in person | `SameSite=Strict`, an origin check, and JSON-only writes |
| Clickjacking, script injection | Content Security Policy, `X-Frame-Options`, `X-Content-Type-Options` |
| Clear-text passwords | The server speaks plain HTTP, so `deploy` refuses to listen beyond this machine unless `TRUST_PROXY=1` says a TLS proxy is in front |
| Forged client address | `X-Forwarded-For` is ignored unless `TRUST_PROXY=1` |
| Guessing portal links | Links are 256-bit; 20 misses in 15 minutes from one address blocks that address, and every miss is logged |
| Portal spam | 10 applications an hour from one address; a retry of an earlier one is still answered |

Because a session is tied to its IP address, someone whose address changes mid-session
(moving between networks, for example) has to sign in again.

An attacker who knows a username can still lock that person out from up to 20 failures
across many addresses, for as long as the guessing continues. That is the cost of
stopping distributed guessing.

## The audit trail

Every attempt is written to the append-only `audit_event` table, with IP address,
browser and time, before the answer goes out. If it cannot be written, the login is
refused. Administrators review it with `GET /api/auth/attempts` (`?alerts=1` for
failures). Alerts also go to the server's error output.

## Personal data held (PII)

| Data | Where | Why | Protection |
|---|---|---|---|
| Username, display name | `auth_user` | Identify staff | Access by role |
| Password | `auth_user` | Sign-in | Salted scrypt hash only |
| Authenticator secret | `auth_user` | Check codes | AES-256-GCM, key held outside the database |
| IP address, browser string | `audit_event`, `auth_session`, `auth_challenge` | Security audit | Administrators only |
| Username typed at login | `audit_event` | Security audit | Administrators only. Someone could type their password here by mistake. |
| Who did what, and when | `audit_event` | Accountability | Append-only, read by role |
| Permit applicant's name and contact, property address, description | `permit` | Decide the application | Code enforcement officers and permit clerks only. The queue leaves them out, and opening a permit is logged. Administrators cannot read them. |
| Resident's email address, and the messages sent to it | `notification` | Confirm applications and inspections | Shown to the resident through their private link. Kept out of the audit trail. |
| Resident's IP address and browser on the portal | `audit_event` | Security audit, abuse limits | Administrators only. Removed from what officers and clerks see. |
| Private portal link | `permit_access` | Lets a resident back to their application | Only a hash is stored |

Passwords, codes and session tokens are never logged. Because the audit trail cannot
be erased, permit audit events leave out the applicant's name and contact, the
address and the description. They do keep the officer's decision reason, so officers
should not put personal details in it.

**Decisions the City still has to make:**

- **Retention.** Nothing is deleted today. The audit trail is append-only and grows
  forever, and expired sessions and challenges stay in their tables. The City should
  set a retention period that fits its records rules.
- **Resident identity.** Residents have no accounts. Anyone with a resident's private
  link can see that application and move its inspection, so the link is treated like a
  password: it is shown once, emailed, kept out of the address sent to the server
  (it sits after `#`), and only its hash is stored. A lost link cannot be recovered;
  staff would have to help. Whether the City wants resident accounts instead is open.
- **Email.** No mail service is connected. Messages are sent through a simulated
  transport and shown on the portal, and nothing leaves the machine.
- **Encryption at rest.** The database file itself is not encrypted, so full-disk
  encryption on the server is expected.

## Operating it

```
npm run auth-admin -- add-user <username> --role <role> [--name "Full Name"]
npm run auth-admin -- reset-authenticator <username>
npm run auth-admin -- set-password <username>
npm run auth-admin -- disable <username>
```

Generated passwords and authenticator secrets are shown once, in that terminal.

- **The sign-in key.** `AUTH_SECRET_KEY` (32 bytes, base64) encrypts authenticator
  secrets. Without it, a key file `auth.key` is created beside the database, which is
  only as safe as that folder, so production should set the variable. Back the key up
  with the database: if it is lost, every authenticator must be reset.
- **Not built:** changing your own password, a password reset by email, and
  self-service authenticator setup. An administrator does all of these.
