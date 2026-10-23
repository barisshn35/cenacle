# v0.29 interface design

The approved design for the v0.29 interface rewrite (approved 2026-10-23). These
files are the reference the implementation follows; they are kept exactly as
approved and are not part of any build.

| File | What it shows |
| --- | --- |
| `DESIGN.md` | The design system: tokens, type, layout, components, rules |
| `PRODUCT.md` | Who the interface is for, and what it must feel like |
| `tokens.json` | The tokens of `DESIGN.md` as data |
| `proto2.html` | Chat, thread, Inbox board and phone (`?s=chat`, `?s=thread`, `?s=inbox`, `?s=phone`, `&theme=dark`) |
| `proto-signin.html` | Sign-in policy: server address, credentials, authenticator enrolment and code, recovery, admin settings, web app turned off |
| `proto-id.html` | Cenacle ID pages, including the optional single sign-on and passkey variants |
| `pages-*.html` | Every other screen: views, channel, navigation, settings, administration |
| `app.css`, `app-kit.js`, `icons.js` | Shared styles and helpers of the prototypes |

Open any HTML file directly in a browser; nothing is loaded from outside.

Direction, in short: **Minutes** (messages set beside a speaker margin), the
**title block** in channel details, and the **Departures** board for the Inbox.
Paper ground, Forest sidebar, Brass only for selection, focus and send; red only
for the reader's own mentions, errors and destructive actions; no thick or black
frames; public channels use the bubble from the logo.

Known adjustments for the build: raise control borders to 3:1 contrast, render the
prototypes' span-based controls as real buttons, and make "no limit" the default
for session lifetimes.

The Geist fonts are © Vercel, under the SIL Open Font License 1.1.
