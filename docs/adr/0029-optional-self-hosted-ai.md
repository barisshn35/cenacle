# 0029. Optional, self-hosted AI (v0.24)

- Status: accepted
- Date: 2026-10-22

## Context

Summaries of long channels and threads, help with writing and questions over past
conversations save people time. They also send conversations to a language model, which
many organizations must not do with a third party, and some do not want at all.

## Decisions

1. **Off by default, twice.** The operator configures a model (`CENACLE_AI_URL`,
   `CENACLE_AI_MODEL`, optionally `CENACLE_AI_API_KEY`); without it the API answers
   `ai_off` and the session says `permissions.ai: false`. With it, each workspace's owners
   and admins still turn AI on (audited). While either is off, the app shows no AI element
   at all: no buttons, menus, views or settings (the setting appears only to admins of a
   server with a model).
2. **The operator's own model.** Cenacle speaks the OpenAI-compatible chat completions API
   that Ollama, vLLM, llama.cpp and LocalAI serve, so the model runs next to Cenacle;
   nothing goes to a third party unless the operator points it there. The address is
   trusted configuration (it may be on a private network); redirects are not followed and
   answers over 1 MiB are refused.
3. **Features:**
   - _Summarize_ a channel's recent messages or a thread, shown only to the asker.
   - _Rewrite_ a draft (clearer, shorter, more formal, friendlier, translated); the draft
     changes only when the person chooses the new text.
   - _Ask_ a question: Cenacle finds the best-matching messages the asker can read
     (full-text search, never encrypted channels) and the model answers from them, citing
     them; the sources are listed as links.
4. **Privacy and safety.** Only messages the asker can read are sent, without deleted,
   burn-on-read or encrypted ones, at most 24,000 characters. Mentions are replaced by
   "@someone". Prompts tell the model that messages are data, not instructions. Answers
   are marked "Written by AI". Requests are recorded (kind, sizes; no content) and limited
   to 30 per person every 10 minutes.

5. **Each person agrees first (v0.99).** Before a person's first AI request a notice says
   what is sent (their request and the messages read for it), where (the configured model
   and its host), what Cenacle keeps (kind and size, no text) and, if the operator set
   `CENACLE_AI_POLICY_URL`, links what the model server keeps. They accept or decline; the
   server refuses AI requests (`ai_consent`) until they accept. Declining hides AI for that
   person. The answer is stored per person for one model, so a new model asks again; it is
   audited (`ai.consent_changed`), part of their data export and removed when they are
   erased. Settings → AI shows it and changes it.

## Consequences

- Quality depends on the model the operator runs; small local models summarize well,
  answers to questions need a larger one.
- No embeddings or vector store yet: retrieval is the existing PostgreSQL full-text index.
