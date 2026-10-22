# AI (optional)

Cenacle's AI features use a language model you run. They are off until you configure one,
and each workspace then turns them on in its settings (workspace menu → Workspace settings →
AI). While off, the app shows nothing about AI.

## Run a model

Any server with the OpenAI-compatible chat completions API works. With Ollama next to the
compose stack:

```sh
docker run -d --name ollama --network cenacle_default -v ollama:/root/.ollama ollama/ollama
docker exec ollama ollama pull qwen2.5:7b-instruct
```

Then in `.env.prod`:

```sh
CENACLE_AI_URL=http://ollama:11434/v1
CENACLE_AI_MODEL=qwen2.5:7b-instruct
# CENACLE_AI_API_KEY=…   (only if your server asks for one)
# CENACLE_AI_TIMEOUT=2m
```

and `docker compose -f prod.yml --env-file .env.prod up -d server`.

## What is sent

Only messages the person asking can read, at most 24,000 characters per request, never
deleted, burn-on-read or encrypted ones. Requests are logged without their content
(`ai_requests`: kind and sizes) and limited to 30 per person every 10 minutes. The model's
address is your configuration: Cenacle does not apply its outgoing-address rules to it, so
keep it on your own network.
