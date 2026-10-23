# 0032. The sign-in policy (v0.29)

- Status: accepted
- Date: 2026-10-23

## Context

Cenacle is meant for organisations that run it on their own servers, usually next to a
directory (Active Directory or LDAP). Until v0.28 every way to sign in was available
at once (password, passkeys, federation), two-step verification was optional, sessions
ended after 7 idle or 30 days, and the web app was always reachable. Organisations
asked for a stricter and simpler default: one way in that their people already know,
always with a second factor, and no reason to sign in again every week. Some also want
Cenacle only in their managed desktop and mobile apps, never in a browser.

## Decisions

1. **One default way in.** The server address, the directory user name and password,
   and a code from an authenticator app. On the web the server address is the page's own
   origin, shown on the sign-in screen; the desktop and mobile apps ask for it first and
   pair with that server.
2. **Two-step verification is required by default.** Cenacle ID keeps a single
   `sign_in_policy` row (`require_two_step`, default true; `passkeys`, default false).
   Anyone signing in without an authenticator enrols inside the sign-in itself: a QR code,
   a code to confirm it, then ten recovery codes, and only then continues to the app.
   While it is required, people cannot turn it off on their account page. Administrators
   change the policy at Cenacle ID's administration, Sign-in; each change is audited.
3. **Passkeys and single sign-on are off** until an administrator turns them on
   (passkeys in the policy, federation per connection as before).
4. **Sessions last until sign-out.** `CENACLE_SESSION_IDLE_TIMEOUT` and
   `CENACLE_SESSION_MAX_AGE` default to `none`. A session without a limit is stored with
   an expiry a hundred years ahead, so the queries keep one shape; the cookie is capped at
   the browsers' 400 days and renewed whenever the app opens. Ending sessions (account
   page, administrators, back-channel logout from Cenacle ID) works as before.
   Operators who need limits set them again.
5. **The web app can be turned off.** A single-row `instance_settings` table holds
   `web_app` (default on). Server administrators change it in Settings; each change is
   audited. While it is off, any request signed in with the session cookie gets
   `403 web_app_off` and loses the cookie, and new sign-ins in a browser return to the app
   with an explanation; bearer tokens (desktop, mobile, bots) are not affected. The public
   `GET /api/meta` tells the app, which then shows where to get the other apps. Each
   server instance reads the setting at most every five seconds. `CENACLE_WEB_APP=on|off`
   overrides the setting, so administrators who locked themselves out can recover.

## Consequences

- Existing accounts without an authenticator enrol at their next sign-in. Installations
  that relied on passkeys turn them on again after upgrading.
- Until the desktop app ships (v0.30) turning the web app off leaves only the API; the
  setting says so plainly.
- Long-lived sessions put more weight on ending them: the session list, ending all
  sessions and back-channel logout stay the tools for a lost device.
