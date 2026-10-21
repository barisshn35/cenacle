# 0016. Scaling and operations (v0.13)

- Status: accepted
- Date: 2026-10-22

## Context

Installations grow from one host to several instances and need to be watched, backed up,
upgraded without downtime, installed offline and moved to from other chats.

## Decisions

1. **Stateless instances.** All state is in PostgreSQL, Valkey and the object store;
   background work is coordinated by River and advisory locks. Caddy balances requests and
   WebSockets across every `server` instance it resolves (`dynamic a`, least connections,
   retry on another instance); Helm runs several replicas.
2. **Drain before stop.** On SIGTERM the server fails `/readyz` for `CENACLE_DRAIN_DELAY`
   while still serving, then shuts down; Helm uses rolling updates with no unavailable pod.
   **Migration policy:** a release only adds to the schema in ways the previous release
   tolerates; removals come in a later release (expand, then contract).
3. **Metrics and traces.** Prometheus metrics on a separate internal port (server:
   `client_golang`; Cenacle ID: `prom-client`), labeled by route pattern, never by raw path.
   Traces with OpenTelemetry over OTLP/HTTP only when the standard `OTEL_*` variables name an
   endpoint (`otelhttp`, `otelpgx`); logs carry `trace_id`. No data leaves the installation
   unless configured.
4. **Observability stack** (`observability.yml`, optional): Prometheus, Tempo, Loki with
   Alloy and Grafana (AGPL ones as separate services), provisioned data sources and a
   dashboard, on an internal network; only Grafana is published, on 127.0.0.1. Every
   component's usage reporting, update checks and plugin downloads are off.
5. **Backups.** WAL-G (Apache-2.0) for continuous archiving and point-in-time recovery
   (`backup.yml`, optional), built from source into the same Alpine PostgreSQL image so the
   data volume and its collation do not change; restore drill documented and run.
6. **Operator CLI.** `status` (dependencies, migration, counts) and `support-bundle`
   (status, settings with secrets replaced by "set", runtime; no content or people).
7. **Kubernetes.** A Helm chart for server, Cenacle ID and web with migrations as hooks,
   probes, PDBs, optional NetworkPolicy and ServiceMonitor; data services are external.
   `helm lint --strict` and a render with every option run in CI.
8. **Offline installs.** `deploy/airgap/bundle.sh` saves every image of the chosen stack
   with checksums; `load.sh` verifies and loads them.
9. **Moving from Mattermost or Slack** is a one-time import from export files (not an
   integration: Cenacle never connects to them). People are matched by e-mail address;
   people without an account get one that the first sign-in with the same **verified**
   address takes over. Message ids are made from the original times, so history sorts
   correctly; imports are idempotent (nonces derived from the source).

## Consequences

- Compose upgrades restart a service briefly; zero-downtime upgrades need several
  instances behind a load balancer that honours readiness (Kubernetes).
- Whoever controls a verified address at Cenacle ID receives the imported history of that
  address; the identity server is trusted to verify addresses.
