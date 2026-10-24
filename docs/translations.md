# Translations

Cenacle ships in English (the source) and Turkish. Everything is bundled: no translation is
fetched at run time.

## Where the texts are

| Part                           | Files                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Web and desktop app (the chat) | `web/src/i18n/<lang>.json`                                                       |
| Design-system components       | `packages/ui/src/i18n/<lang>.json`                                               |
| Cenacle ID sign-in pages       | `idp/src/ui/locales/<lang>.ts` (English and Turkish in `idp/src/ui/messages.ts`) |
| Cenacle ID administration      | `idp/src/admin/locales/<lang>.ts`                                                |
| Desktop menus and dialogs      | `desktop/src/locales/<lang>.ts`                                                  |

The JSON files are i18next resources (nested keys, `{{name}}` placeholders, plural forms as
`key_one` / `key_other`; languages with more plural forms add CLDR's, e.g. Arabic's
`key_zero` … `key_other`). The TypeScript files are
checked against the English object's type, so a missing or extra key fails the build.

## Rules

- Translate values only; keep keys, placeholders, tags (`<0>…</0>`), product names (Cenacle,
  Cenacle ID) and technical words (`@channel`, SCIM, OIDC, NDJSON, …) as they are.
- Keep the tone of the English: short, calm, verbs on buttons, sentence case, no
  exclamation marks. The terms are in [docs/ux/glossary.md](ux/glossary.md).
- `pnpm --filter web test` checks that Turkish has every key of English; CI runs it. A new
  language gets the same check there.

## Adding a language

1. Copy `en.json` to `<lang>.json` in `web/src/i18n` and `packages/ui/src/i18n`, and the
   English objects to new files under `idp/src/ui/locales`, `idp/src/admin/locales` and
   `desktop/src/locales`; translate them.
2. Add the language to `LANGUAGES` and `LANGUAGE_NAMES` in `web/src/i18n/index.ts` (and to
   the right-to-left set there if it is written that way), to `uiResources` in
   `packages/ui/src/i18n/index.ts`, to `LOCALES` and the maps in the two IdP message files,
   and to `ALL` in `desktop/src/i18n.ts`.
3. Add it to the language test in `web/src/i18n/i18n.test.ts`.

Layouts use logical CSS (`ms-`, `pe-`, `start-`, `text-start`, …) so they mirror for
right-to-left languages; icons that point a way are mirrored in
`packages/ui/src/styles/globals.css`.

## Translating with Weblate

The files work with a self-hosted [Weblate](https://weblate.org) (GPL, run as its own
service): add a component per file set with the "i18next JSON file" format and English as
the source language, and let it open merge requests against the repository. Contributions
are signed off like code ([CONTRIBUTING.md](../CONTRIBUTING.md)).
