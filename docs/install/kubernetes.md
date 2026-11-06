# Installing Cenacle on Kubernetes

The Helm chart in [`deploy/helm/cenacle`](../../deploy/helm/cenacle) runs the chat
server, Cenacle ID and the web app. PostgreSQL 18, Valkey and an S3-compatible object
store come from your platform (operators, managed services or Garage). The chart needs
Kubernetes 1.30 or later.

1. Create two PostgreSQL databases and users (`cenacle_chat`, `cenacle_idp`), a Valkey,
   and a bucket with an access key. The chat server's tables can live in a schema other
   than `public`: create it owned by `cenacle_chat` and add `search_path=<schema>` to
   `chat-database-url`. The `unaccent` extension of search still goes into `public`, so
   that schema must stay (an install without it stops at migration 00017).
2. Create the Secret the chart reads (name `cenacle`, or set `existingSecret`):

   ```sh
   kubectl create secret generic cenacle \
     --from-literal=chat-database-url='postgres://cenacle_chat:…@postgres:5432/cenacle_chat' \
     --from-literal=idp-database-url='postgres://cenacle_idp:…@postgres:5432/cenacle_idp' \
     --from-literal=valkey-password='…' \
     --from-literal=chat-client-secret="$(head -c 32 /dev/urandom | base64)" \
     --from-literal=idp-key-encryption-key="$(head -c 32 /dev/urandom | base64)" \
     --from-literal=idp-cookie-keys="$(head -c 32 /dev/urandom | base64)" \
     --from-literal=s3-access-key='…' --from-literal=s3-secret-key='…'
   ```

   Optional keys: `smtp-password` (e-mail) and `ai-api-key` (a model server that wants
   one); `azure-key` instead of the S3 keys with `files.backend=azure`. The pods read the
   required keys as files under `/run/secrets/cenacle` (`*_FILE` settings), the optional
   ones as variables. Keep a copy of this Secret with your backups: without `idp-key-encryption-key`
   Cenacle ID cannot read its signing keys or directory settings
   ([backup guide](../backup/README.md)).

3. Install:

   ```sh
   helm install cenacle deploy/helm/cenacle \
     --set domain=chat.example.com --set idDomain=id.example.com \
     --set admin.email=you@example.com \
     --set s3.endpoint=http://garage.storage:3900 \
     --set s3.ingressBackend.service=garage --set ingress.className=traefik
   ```

4. Create the administrator's account in Cenacle ID, with the address you gave as
   `admin.email` (it asks for the password twice, without showing it):

   ```sh
   kubectl exec -it deploy/cenacle-idp -- \
     node dist/cli.js users create --email you@example.com --name "Your Name" --verified
   ```

   Then sign in at `https://chat.example.com`; the first sign-in sets up two-step
   verification. More accounts and Cenacle ID operations: see
   [First account and Cenacle ID operations](README.md#first-account-and-cenacle-id-operations).

Images come from `ghcr.io/cenacle-tr` (`image.registry`), a public registry that needs no
pull secret. For air-gapped clusters, copy the images into your own registry and point
`image.registry` to it (add a pull secret to `imagePullSecrets` when yours asks for one).

Migrations run as Helm hooks before every install and upgrade; pods are replaced one at a
time with a drain delay ([operations](../operations/README.md#upgrades-without-downtime)).
Uploads go from browsers to the bucket through the ingress (`POST /<bucket>/`, signed
forms only); with an external S3 service set `s3.uploadURL` to its bucket URL and allow
`POST` from the chat domain in its CORS rules instead (the web app's content security
policy then allows that origin).

Files elsewhere: `files.backend=azure` with `azure.*`, or `files.backend=dir` with
`files.dir.existingClaim`, a ReadWriteMany PersistentVolumeClaim every server replica
mounts at `/data/files`; `files.backend=off` turns files off. Archive exports and imports
are staged in the server's `/tmp`, an `emptyDir` of at most `server.tmpSize` (default
`1Gi`).

The pods run as the images' users (server 65532, Cenacle ID 1000, web 10001) with a
read-only root file system.

The Ingress sends `/api`, `/ws`, `/healthz` and `/readyz` of the chat domain to the chat
server, the rest to the web container, so `https://<chat-domain>/readyz` answers with the
server's checks (JSON; 503 when one fails, or the controller's own 503 when no server pod is
ready). Tested on 2026-11-05 with Traefik 3.6 (k3s 1.35) and with ingress-nginx 1.15.1 (Helm
chart 4.15.1, k3s 1.35): with both, the chat domain's `/healthz` and `/readyz` reached the
server, `/readyz/x` got the server's 404, and with the server not ready the controller
answered 503. The health paths are `Prefix` rules: Traefik ranks routes by the length of
their rule, and an `Exact` `/readyz` lost to the web's `/`. Use the `ingress.className` of
your controller; the example above uses `traefik` (the one k3s ships). ingress-nginx was
retired in March 2026 (no new releases or security fixes; [Kubernetes
blog](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)); prefer another
controller for a new cluster.

Ingress controllers limit how long a request may take and how large its body may be; check
both for `/ws` and for uploads (at least `files.maxSizeMB`):

- **Traefik** (tested on 2026-11-05, Traefik 3.6.13 of k3s 1.35): no body size limit by default;
  a WebSocket that stayed silent for 5 minutes stayed open. It ends a request whose body
  takes longer than 60 seconds to arrive (`readTimeout`): a 6 MB upload at 50 kB/s was cut
  at 60 s. Raise it on the entry points, in k3s with a `HelmChartConfig`:

  ```yaml
  apiVersion: helm.cattle.io/v1
  kind: HelmChartConfig
  metadata: { name: traefik, namespace: kube-system }
  spec:
    valuesContent: |-
      ports:
        web: { transport: { respondingTimeouts: { readTimeout: 3600s } } }
        websecure: { transport: { respondingTimeouts: { readTimeout: 3600s } } }
  ```

  (with Traefik's own chart, the same `ports` values). With 3600s the same upload took
  117 s and arrived whole.

- **ingress-nginx:** `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` for `/ws` and
  `proxy-body-size` for uploads.

Cenacle ID limits sign-in attempts per client address and takes that address from
`X-Forwarded-For`, trusting `idp.trustProxy` proxies (default `1`: the ingress controller).
With a load balancer in front of the controller that appends to the header, set `2`, or the
proxies' addresses and CIDR ranges (`10.0.0.0/8,192.0.2.7`). Never trust more hops than
there are proxies: a client could then choose its own address.

Options: `metrics.serviceMonitor.enabled` (Prometheus Operator), `otlpEndpoint`,
`networkPolicy.enabled`, `podDisruptionBudget`, resources and scheduling per component;
`server.logLevel`, `server.sessionIdleTimeout`, `server.sessionMaxAge`, `server.webApp`,
`server.desktopMinVersion`, `server.auditRetention`, `server.aiRequestRetention`,
`server.linkPreviewRetention`, `idp.logLevel`, `idp.databasePoolMax`, `idp.privacyUrl` and
`idp.keyRetiredGraceSeconds` match the settings of the
[Compose installation](README.md). See
[`values.yaml`](../../deploy/helm/cenacle/values.yaml).

With `networkPolicy.enabled`, only the ingress controller's namespace reaches the pods; name
it in `networkPolicy.ingressNamespaceSelector` (required, the chart stops without it):
`kube-system` for the Traefik of k3s, usually `traefik` for Traefik's own chart and
`ingress-nginx` for ingress-nginx:

```sh
--set networkPolicy.enabled=true \
--set-string 'networkPolicy.ingressNamespaceSelector.matchLabels.kubernetes\.io/metadata\.name=kube-system'
```

Tested on 2026-11-05 with Traefik 3.6.13 of k3s 1.35: the chart's pages answered through
Traefik; with another namespace named, Traefik got 502 for every request. A changed policy
holds for new connections: restart the controller after changing it, or connections it
already keeps open still pass.

Any other setting goes into `server.extraEnv` or `idp.extraEnv`, lists of container
environment variables (values or `valueFrom` references):

```yaml
server:
  extraEnv:
    - { name: CENACLE_SHUTDOWN_TIMEOUT, value: 30s }
    - { name: CENACLE_READY_TIMEOUT, value: 5s }
```

Do not repeat a variable the chart already sets; change its value instead (a duplicate
name makes upgrades of the Deployment unreliable).
