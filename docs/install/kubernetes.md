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

3. Install:

   ```sh
   helm install cenacle deploy/helm/cenacle \
     --set domain=chat.example.com --set idDomain=id.example.com \
     --set admin.email=you@example.com \
     --set s3.endpoint=http://garage.storage:3900 \
     --set s3.ingressBackend.service=garage --set ingress.className=nginx
   ```

Migrations run as Helm hooks before every install and upgrade; pods are replaced one at a
time with a drain delay ([operations](../operations/README.md#upgrades-without-downtime)).
Uploads go from browsers to the bucket through the ingress (`POST /<bucket>/`, signed
forms only); with an external S3 service set `s3.uploadURL` to its bucket URL and allow
`POST` from the chat domain in its CORS rules instead.

Ingress controllers close idle connections; raise the timeout for `/ws` (e.g. nginx:
`nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"`) and the request body size for
uploads (`proxy-body-size` at least `files.maxSizeMB`).

Options: `metrics.serviceMonitor.enabled` (Prometheus Operator), `otlpEndpoint`,
`networkPolicy.enabled`, `podDisruptionBudget`, resources and scheduling per component.
See [`values.yaml`](../../deploy/helm/cenacle/values.yaml).
