# Security Policy

## Supported versions

Cenacle is pre-1.0. Only the latest released minor version receives security fixes.

| Version      | Supported |
| ------------ | --------- |
| 0.x (latest) | ✅        |
| older        | ❌        |

## Reporting a vulnerability

**Please do not open public issues for security problems.**

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/barisshn35/cenacle/security/advisories/new).
Include:

- affected component (`server`, `idp`, `web`, deployment files) and version or commit,
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any suggested mitigation.

We aim to acknowledge reports within 3 working days and to agree on a disclosure
timeline with the reporter. Fixed issues are published as GitHub Security Advisories
and noted in `CHANGELOG.md`.

## Scope

Cenacle is self-hosted. Issues in an operator's own infrastructure (reverse proxy,
TLS configuration, host hardening) are out of scope unless caused by our defaults
or documentation.
