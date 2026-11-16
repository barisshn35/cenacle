# ADR 0057: E-mail from Cenacle ID

Status: accepted (2026-11-13).

## Context

Cenacle ID sent no e-mail. Local accounts therefore cannot reset a forgotten
password, administrators cannot invite someone by e-mail, and nobody hears
of a sign-in from a new device. The chat server sends e-mail through a mail
server set in its configuration or in the system console (migration 00081),
but the two services keep separate databases and Cenacle ID must not depend
on the chat server: it signs people in to it.

## Decision

- **Its own mail server setting.** Cenacle ID sends through a mail server named
  by `IDP_SMTP_HOST`, `IDP_SMTP_PORT`, `IDP_SMTP_SECURITY` (`starttls`, `tls` or
  `none`), `IDP_SMTP_USERNAME`, `IDP_SMTP_PASSWORD` (or `_FILE`) and
  `IDP_SMTP_FROM`; without a host, administrators set it in the admin panel
  (Admin → E-mail). The configuration wins and the panel then only shows it.
  Most installations point both services at the same server and account.
- **The password is encrypted at rest** with the key that already protects
  signing keys and directory secrets (`IDP_KEY_ENCRYPTION_KEY`, AES-256-GCM,
  bound to the row), is never shown again and is removed with the account.
- **No password over an unencrypted connection**: `none` (a relay inside the
  network) allows no account. TLS needs version 1.2 or newer and a valid
  certificate for the host name.
- **nodemailer** (MIT-0, no dependencies) speaks SMTP. File and URL access of
  its message builder are turned off: messages are built from Cenacle ID's own
  templates only.
- **Administrators only**: the panel page, its changes (audited without the
  password) and a test e-mail to the administrator's own address.
- Messages are short, plain text with an HTML alternative, in the person's
  language (English or Turkish), with no remote images or tracking.

## Consequences

- Password reset, invitations and new sign-in notices (phase 1) build on this.
- An installation without a mail server keeps working; features that need
  e-mail say so and offer what an administrator can do instead.
- Two places name a mail server (chat and Cenacle ID); the install guide says
  to use one sending account for both.
