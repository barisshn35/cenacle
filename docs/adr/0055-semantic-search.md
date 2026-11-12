# ADR 0055: Semantic search

Status: accepted (2026-11-12).

## Context

Search finds the words people type (PostgreSQL full-text search, ADR 0020).
People often remember what was meant rather than the words used: "the decision
about the release date" when the message said "we ship on the 4th". Ask AI
(ADR 0029) answers from the messages search finds, so it misses the same ones.
Cenacle is self-hosted: the meaning of messages may only be worked out by the
model server the operator runs, and only where a workspace turned AI on.

## Decision

- **Embeddings from the operator's model server**: the same OpenAI-compatible
  API as the other AI features (`/embeddings`), with its own model,
  `CENACLE_AI_EMBEDDING_MODEL` (for Turkish and English, e.g. `bge-m3` in
  Ollama). Without it the feature is off.
- **Vectors in PostgreSQL with pgvector** (0.8.7, PostgreSQL License, built from
  pinned source into the stack's own PostgreSQL image, `cenacle-postgres`, still
  the official Alpine image underneath so existing data directories keep their
  collations). pgvector is not a trusted extension: the database's first start
  creates it, `install.sh` creates it for an existing volume, and an external
  database needs its administrator to run `CREATE EXTENSION vector SCHEMA public`
  in the chat database. Without it the feature stays off and the system console says why.
- **The vector table follows the model**: its width is the model's, so the
  server creates `message_vectors` (halfvec, an HNSW index for cosine distance)
  when the feature is first on and again when the model changes (the old
  vectors go and every message is indexed anew). This is the one table not made
  by a migration; the queue and the index's state are (`00079`).
- **What is indexed**: messages of workspaces with AI on, as they are written or
  edited (a trigger queues them), not those of encrypted channels, burn-after-
  reading messages or deleted ones. Turning AI off in a workspace removes its
  vectors; turning it on queues its messages. A periodic job sends the text (at
  most 2000 characters a message) in batches.
- **Searching by meaning**: the search panel offers "By meaning" where the
  workspace's AI is on and the person accepted the AI notice; the query goes to
  the model server, and the nearest messages among the channels the person can
  read come back, with the usual filters. Ask AI finds its sources by meaning
  too, and by words when the feature is off.

## Consequences

- Vectors take about 2 KB a message (1024 dimensions, half precision); the
  operator's model server does the work, one batch at a time.
- A first index of a large server takes a while; search by words keeps working.
- Retention, erasure and deletion remove vectors with their messages (the table
  refers to them).
