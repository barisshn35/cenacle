# Installing Cenacle on Kubernetes

The Helm chart in [`deploy/helm/cenacle`](../../deploy/helm/cenacle) runs the chat
server, Cenacle ID and the web app. PostgreSQL 18, Valkey and an S3-compatible object
store come from your platform (operators, managed services or Garage).

1. Create two PostgreSQL databases and users (`cenacle_chat`, `cenacle_idp`), a Valkey,
   and a bucket with an access key.
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
     --set s3.ingressBackend.service=garage --set ingress.className=nginx
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

Images come from `git.calaixo.com:5050/calaxio/cenacle` (`image.registry`); when that
registry asks for credentials, add a pull secret to `imagePullSecrets`. For air-gapped
clusters, copy the images into your own registry and point `image.registry` to it.

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

Ingress controllers close idle connections; raise the timeout for `/ws` (e.g. nginx:
`nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"`) and the request body size for
uploads (`proxy-body-size` at least `files.maxSizeMB`).

Options: `metrics.serviceMonitor.enabled` (Prometheus Operator), `otlpEndpoint`,
`networkPolicy.enabled`, `podDisruptionBudget`, resources and scheduling per component;
`server.logLevel`, `server.sessionIdleTimeout`, `server.sessionMaxAge`, `server.webApp`,
`server.desktopMinVersion`, `idp.logLevel`, `idp.databasePoolMax` and
`idp.keyRetiredGraceSeconds` match the settings of the
[Compose installation](README.md). See
[`values.yaml`](../../deploy/helm/cenacle/values.yaml).

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
