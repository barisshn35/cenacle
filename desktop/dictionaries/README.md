# Spell checker dictionaries

The desktop app checks spelling with these files and downloads none (`src/spellcheck.ts`).
Electron would otherwise fetch the dictionary of the system's language from Google the
first time it checks a word. The files are in Chromium's own format (`.bdic`) and named as
the Chromium of the app's Electron looks for them
(`components/spellcheck/common/spellcheck_common.cc`).

| File              | Language | Source                                                                                                                                                                                                                                                                                                                                             | SHA-256                                                            | License                                                                                                  |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `en-US-10-1.bdic` | en-US    | [hunspell_dictionaries](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries) at `cccf64a8acc951afe3f47fee023908e55699bc58` (the revision Chromium 152.0.7977.167, Electron 44.9.3, uses); SCOWL en_US 2020.12.07                                                                                                                 | `a075b01d9b015c616511a9e87da77da3d9881621db32f584e4606ddabf1c1100` | SCOWL's permissive notice, BSD-style Ispell affix notice, public domain parts ([NOTICE.txt](NOTICE.txt)) |
| `tr-TR-4-0.bdic`  | tr       | [hunspell-tr](https://github.com/tdd-ai/hunspell-tr) of Turkish Data Depository at `7302eca5f3652fe7ae3d3ec06c44697c97342b4e` (2023-12-30; the same files as `tr_TR` in LibreOffice's dictionaries repository), converted unchanged with Qt WebEngine's `qwebengine_convert_dict` (6.8.2), which writes the same file as Chromium's `convert_dict` | `dfa85ece95bc43f8eb03d664cbad6aa633868acbf9697d3ef3844a8bd1f11c69` | MPL-2.0 ([source/LICENSE](source/LICENSE))                                                               |

`NOTICE.txt` goes into the app's `THIRD_PARTY_NOTICES.txt`. The Turkish dictionary's source
(MPL-2.0 asks that it can be had) is in `source/`, as published at the commit above:

| File               | SHA-256                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `source/tr_TR.aff` | `a04a227b2ee45574000b876a1afa982e3436d49ebb97a7a796ddc5ec0cc8191b` |
| `source/tr_TR.dic` | `48e5352c5770956b24f355265aef7649b25bcb4d933c0b254ea8b419c241f4bd` |
| `source/LICENSE`   | `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04` |

To build the `.bdic` again: `qwebengine_convert_dict source/tr_TR.dic tr-TR-4-0.bdic` (Debian's
`qt6-webengine-dev-tools`; it reads the `.aff` next to the `.dic`). The packages take only the
`.bdic` files and `NOTICE.txt`, not `source/`.

When Electron is upgraded, check the names in `spellcheck_common.cc` of its Chromium: a new
dictionary version needs the file of that version.
