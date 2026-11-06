# Security Policy

## Supported versions

Security fixes go to every supported version: the latest feature release and the extended
support releases (ESR) within their 12 months. Which versions those are, and for how long, is in
the [support policy](docs/operations/support-policy.md). Before 1.0.0 only the latest 0.x
release is supported.

## Reporting a vulnerability

**Please do not open public issues for security problems.**

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/Cenacle-TR/cenacle/security/advisories/new).
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
