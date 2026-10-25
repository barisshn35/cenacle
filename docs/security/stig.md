# STIG profile

How to run Cenacle in line with DISA's Security Technical Implementation Guides: the
[Application Security and Development STIG](https://public.cyber.mil/stigs/) for the
application and the container platform guidance for the images. This page maps the
requirement areas to what Cenacle provides and what the operator sets; it is not a
DISA-approved checklist. Assessors use the current STIG release and its rule ids.

## Deploying

```sh
cd deploy/compose
# .env.prod: CENACLE_IMAGE_VARIANT=-fips, IDP_SIGNIN_NOTICE="…"
docker compose -f prod.yml -f stig.yml --env-file .env.prod up -d
```

Kubernetes: `image.fips: true`, `idp.signinNotice`, and the chart's defaults (below).

## Requirement areas

| Area                              | Cenacle                                                                                                                   | Operator                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Notice and consent before logon   | `IDP_SIGNIN_NOTICE`: shown and accepted before every way to sign in (form, passkey, other providers)                      | Set the text the organization requires                           |
| Approved cryptography             | FIPS images (fips.md); TLS 1.2+ only                                                                                      | Use the `-fips` images; FIPS builds of PostgreSQL where required |
| Identification and authentication | Accounts in Cenacle ID or the directory (LDAP/AD, SAML, OIDC); TOTP and passkeys; NIST SP 800-63B password rules          | Require two-step verification in Cenacle ID's sign-in policy     |
| Failed sign-ins                   | Sign-in attempts limited per address (`IDP_LOGIN_RATE_LIMIT`); the same answer for unknown accounts and wrong passwords   | Directory lockout policies for directory accounts                |
| Session limits                    | Session policy: lifetime and idle timeout, also for guests; sign-out everywhere; back-channel logout                      | Set the idle timeout the organization requires (system console)  |
| Access control                    | Workspace and channel roles, permission schemes, attribute-based channel access, admin network restriction                | Restrict administration to the admin networks                    |
| Audit                             | Audit log of security events (sign-ins, roles, settings, exports, escrow), export and streaming to a SIEM (syslog, HTTPS) | Stream to the organization's SIEM; keep logs as long as required |
| Data protection                   | TLS everywhere outside the internal network; end-to-end encryption; retention, legal holds, spillage handling             | Encrypt volumes at the host; back up per docs/backup             |
| Configuration and supply chain    | Signed images with SBOMs; no telemetry; air-gapped installs; `status` and support bundles without secrets                 | Verify signatures (docs/security); pin versions                  |
| Error handling                    | Errors as problem+json with a request id, no stack traces or internals                                                    | —                                                                |

## The images

Every image runs as a non-root user, has no setuid or setgid files and starts with a
read-only root file system, no capabilities and `no-new-privileges` (checked in CI by
`ci/check-image.sh`). The server image is distroless (no shell). `prod.yml` runs them that
way; `stig.yml` adds process and memory limits, no core dumps, and PostgreSQL connection
logging with SCRAM passwords. The Helm chart sets `runAsNonRoot`, the `RuntimeDefault`
seccomp profile, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, drops all
capabilities and does not mount service account tokens.
