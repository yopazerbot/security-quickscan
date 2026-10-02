# Security policy

Security QuickScan handles read access to cloud environments, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately via GitHub:
**Security > Report a vulnerability** on this repository (private vulnerability reporting).

Include what you found, how to reproduce it, the affected version or commit, and the potential impact. You will get an acknowledgement as soon as possible, and fixes are coordinated with you before public disclosure.

## Scope

In scope: the application code in this repository (web app, API, worker, checks, Docker setup).
Out of scope: vulnerabilities in third-party services (Microsoft, AWS, GitHub, hosting providers) and findings that require an already compromised administrator account or host.

## Supported versions

Only the latest version on the `main` branch receives security fixes.

## Hardening notes for operators

- Never expose `LOCAL_MODE` to a network: it has no login by design.
- Keep `MASTER_KEY` (hosted) or the `/data/master.key` volume (local) secret and backed up.
- Protect the sign-in app with Conditional Access (MFA) and "Assignment required".
- Enable break-glass and demo PIN login only when needed.
- Review the audit log regularly.
