# Product


## Platform

web

## Users

Every kind of team in an organization that runs its own servers: technical teams
(software, operations, security: code blocks, bots, alerts, CI notices) and office teams
(public sector and companies: announcements, files, approvals, meetings). Most keep it
open all day on a desktop next to their main work and check it on phones in between.
Beside them: workspace owners and admins (members, roles, retention, directories, audit)
and bot developers (tokens, webhooks, slash commands, delivery logs). Confirmed by the user:
the interface must fit technical and office teams equally.

## Product Purpose

Team chat and its own identity server (Cenacle ID), fully open source and self-hosted:
channels, threads, direct conversations, search, notifications, files, bots, workflows,
canvases and lists, compliance, optional self-hosted AI, federation between servers.
Success, equally weighted (user): an organization's IT and leadership trust it at first
sight (serious, mature, premium), and the people using it all day move fast through
catching up, replying and finding.

## Positioning

Everything Mattermost offers (paid and free) as open source, on the organization's own
servers, air-gapped if needed, with its own identity server; no telemetry, no CDN, no
mandatory SaaS. No bridges to competing products.

## Operating Context

All-day desktop browser use, later an Electron desktop app (v0.99) and phones; dark and
light themes, compact and comfortable density; English and Turkish. Admin work happens in
the same app. Installations run on private networks.

## Capabilities and Constraints

- React 19 SPA, Tailwind v4, shadcn/ui on Base UI (one primitive layer), motion, lucide
  icons (stroke 1.75), cmdk, Sonner, TanStack; fonts bundled, never from a CDN.
- Licence policy: permissive dependencies only.
- UX plan (binding): fast, calm, stable, predictable. Red only for mentions, errors and
  destructive actions; numbered badges only for mentions and DMs; no gamification; no
  auto-playing motion in the message area; drafts never lost; WCAG 2.2 AA, target sizes
  24/28 px fine and 44 px coarse; hover is never the only way; prefers-reduced-motion.
- Terminology from docs/ux/glossary.md (Workspace, never "server").

## Brand Commitments

Binding (user): the logo (arch with a speech bubble, "Upper room") and the colours
Forest `#14342B`, Brass `#C9A24B` (logo bubble on light, accent on dark), Brass-ink
`#8F6B1F` (accent on light), Paper `#FAF7F0`, Night `#0C1A16`, Bone `#F3EEE2`. Brand
colours are never status colours. Layout and typography may change.

## Evidence on Hand

Brand files in web/public/brand and docs/brand; current UI screenshots in this folder
(current-*.png); the "Upper room" prototype (proto.html, new-*.png). No customers,
testimonials or metrics: none may be invented.

## Product Principles

1. Calm by default: attention goes only where something needs the person.
2. Nothing moves or disappears unexpectedly.
3. One vocabulary and one way of doing each thing, everywhere.
4. Serious enough for a ministry, quick enough for an on-call engineer.
5. The organization owns it: nothing leaves its servers.

## Accessibility & Inclusion

WCAG 2.2 AA enforced in CI (axe, target sizes); keyboard for every action; reduced motion;
meaning never by colour alone; English and Turkish (long Turkish strings).
