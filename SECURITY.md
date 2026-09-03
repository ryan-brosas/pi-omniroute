# Security policy

The extension itself holds no secrets; it reads `OMNIROUTE_API_KEY` from your environment
(or pi's `/login` store) and forwards it to your gateway. Treat that key as sensitive —
in keyless mode no `Authorization` header is ever sent.

## Reporting a vulnerability

Please **do not** open a public issue with credentials or gateway details.

- Report privately via GitHub: **Security → Report a vulnerability**
  (https://github.com/ryan-brosas/pi-omniroute/security/advisories/new)
- Include: pi/extension version, gateway version, the payload shape (redacted), observed
  effect, and (if known) the minimal steps to reproduce.

## What's in scope

- The extension itself (index.ts, models.ts, data files).
- Secret handling and keyless behavior (make sure a missing key never leads to a request
  carrying a placeholder or wrong credentials).

## Out of scope

- OmniRoute gateway bugs (file upstream at
  https://github.com/diegosouzapw/OmniRoute).
- Credential hygiene on the gateway side (your `OMNIROUTE_API_KEY`/dashboard keys), auth
  patterns already accepted for other providers.

## Response

Maintenance is hobby-grade; acknowledge within ~7 days, fix priority reflects severity.
