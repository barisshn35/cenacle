# 0013. Typography: default fonts, font library and font templates

- Status: accepted
- Date: 2026-10-22

## Context

Geist and Geist Mono were the interface and code fonts since v0.1. For a calmer, more
corporate default, the user chose Inter with JetBrains Mono, keeping Geist in the library.
Fraunces stays the brand headline face until "Cenacle Display" replaces it (v0.99 design).

## Decisions

1. **Defaults:** Inter (interface and messages) and JetBrains Mono (code), variable fonts
   bundled from Fontsource (SIL OFL-1.1) and served from our own origin, Latin and Latin
   Extended included (Turkish). Cenacle ID uses Inter too.
2. **Font library (v0.16), ten of each, all OFL, all bundled:**
   - Text: Inter, IBM Plex Sans, Geist, Manrope, Source Sans 3, Figtree, Public Sans,
     Plus Jakarta Sans, Noto Sans, Atkinson Hyperlegible Next.
   - Code: JetBrains Mono, IBM Plex Mono, Geist Mono, Fira Code, Source Code Pro, Cascadia
     Code, Roboto Mono, Red Hat Mono, Noto Sans Mono, Commit Mono.
     Faces are declared in CSS and downloaded only when chosen.
3. **Six font templates (v0.16):**

   | Template                | Text                       | Code            |
   | ----------------------- | -------------------------- | --------------- |
   | Corporate (default)     | Inter                      | JetBrains Mono  |
   | Classic corporate       | IBM Plex Sans              | IBM Plex Mono   |
   | Modern                  | Geist                      | Geist Mono      |
   | Product                 | Manrope                    | Fira Code       |
   | Reading                 | Source Sans 3              | Source Code Pro |
   | Legible (accessibility) | Atkinson Hyperlegible Next | Red Hat Mono    |

4. **Own combinations:** users pick any text and code font from the library (and fonts they
   uploaded themselves) with size and line height; workspace admins may set the default
   template of their workspace.

## Consequences

- Text metrics change slightly; target sizes and layouts are verified by the existing
  target-size and accessibility tests.
