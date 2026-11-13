# AI (optional)

Cenacle's AI features use a language model you run. They are off until you configure one,
and each workspace then turns them on in its settings (workspace menu → Workspace settings →
AI). While off, the app shows nothing about AI.

## Run a model

Any server with the OpenAI-compatible chat completions API works. With Ollama next to the
compose stack (on its `edge` network, which the chat server is on):

```sh
docker run -d --name ollama --network cenacle_edge -v ollama:/root/.ollama ollama/ollama
docker exec ollama ollama pull qwen2.5:7b-instruct
```

Then in `.env.prod`:

```sh
CENACLE_AI_URL=http://ollama:11434/v1
CENACLE_AI_MODEL=qwen2.5:7b-instruct
# API key only if your server asks for one: in secrets/ai_api_key
# or here (CENACLE_AI_API_KEY=…), not in both
# CENACLE_AI_TIMEOUT=2m
# Optional: your page on how the model server keeps requests
# CENACLE_AI_POLICY_URL=https://intranet.example.com/ai
```

and `docker compose -f prod.yml --env-file .env.prod up -d server`.

### A hosted model

A hosted service with the same API works the same way: `CENACLE_AI_URL` is its base
address (the part before `/chat/completions`, usually ending in `/v1`), and its key goes in
`secrets/ai_api_key`. Cenacle sends each request with `max_tokens` (1024) and
`temperature` (0.2); a model that refuses either of them answers with an error, and the
request fails for the person who asked. Embedding models up to 4000 dimensions work for
search by meaning. When the service refuses for a while (429), the messages waiting to be
indexed stay in the queue. Requests then leave your network: the notice people accept
names the service's host.

## The notice people accept

Before a person's first AI request, Cenacle shows them what will happen: their request and
the messages the AI reads (only ones they can read) go to the model you configured, named
with the server it runs on, and Cenacle keeps only the kind and size of each request. They
accept or decline. Nothing is sent until they accept; declining hides AI for them, and they
can change their answer in Settings → AI at any time. Each answer is kept with its time and
the model it was given for (`ai_consents`) and recorded in the audit log
(`ai.consent_changed`). When you change `CENACLE_AI_MODEL`, everyone is asked again.

What your model server does with requests is up to its configuration (Ollama and vLLM keep
nothing by default). Say so on a page of your own and set `CENACLE_AI_POLICY_URL` to link it
from the notice.

## What is sent

Only messages the person asking can read, at most 24,000 characters per request, never
deleted, burn-on-read or encrypted ones. Requests are logged without their content
(`ai_requests`: kind and sizes) and limited to 30 per person every 10 minutes. The model's
address is your configuration: Cenacle does not apply its outgoing-address rules to it, so
keep it on your own network.

## Search by meaning (optional)

With an embedding model on the same server, people can search by meaning: messages that
say the same thing in other words (ADR 0055). With Ollama:

```sh
docker exec ollama ollama pull bge-m3
```

and in `.env.prod`:

```sh
CENACLE_AI_EMBEDDING_MODEL=bge-m3
```

The chat database needs pgvector: the stack's PostgreSQL image has it, and `install.sh`
creates the extension (an external database: `CREATE EXTENSION vector SCHEMA public` by its
administrator). The server then indexes the messages of workspaces with AI on, in the
background, sending each message's text (at most 2000 characters) to the model; System
console → Jobs shows how far it is. Encrypted, burn-on-read and deleted messages are never
indexed; turning AI off in a workspace removes its vectors. A search by meaning sends the
query to the model, so it needs the person to have accepted the AI notice. Changing the
model indexes every message again.

If the server stops while it indexes, that run stays "running" in System console → Jobs
until the job queue gives it up after an hour; indexing then goes on by itself. Nothing is
lost meanwhile: the messages wait in the queue.
