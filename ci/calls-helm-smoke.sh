#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# The chart's media service in a disposable k3d cluster, once per
# calls.exposure (hostPort, loadBalancer, hostNetwork), each with a real call:
# server/cmd/media-load stands in for the chat server and three people publish
# audio and camera, reconnect once and must receive everyone again.
#
#   sh ci/calls-helm-smoke.sh
#
# Needs Docker, k3d, kubectl and helm (on PATH or in .bin), the k3s image
# K3S_IMAGE (default rancher/k3s:v1.35.5-k3s1) and the Valkey image of prod.yml.
# Builds cenacle-media:smoke. Port 7883 on this host must be free.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
PATH="$root/.bin:$PATH"
k3s=${K3S_IMAGE:-rancher/k3s:v1.35.5-k3s1}
cluster=cenacle-calls-smoke
work=$(mktemp -d)
pids=''
cleanup() {
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  k3d cluster delete "$cluster" >/dev/null 2>&1 || true
  docker image rm -f cenacle-smoke-valkey:local >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
for tool in docker k3d kubectl helm openssl go; do
  command -v "$tool" >/dev/null || { echo "$tool is needed" >&2; exit 2; }
done
kube() { kubectl --context "k3d-$cluster" -n calls "$@"; }

for n in calls control; do
  openssl genpkey -algorithm ED25519 -out "$work/$n-private.pem" 2>/dev/null
  openssl pkey -in "$work/$n-private.pem" -pubout -out "$work/$n-public.pem"
done
docker build -q -f "$root/server/media.Dockerfile" -t cenacle-media:smoke "$root" >/dev/null
# k3d imports single-platform images only: a local copy of the Valkey image.
valkey=$(sed -n 's/^ *image: \(valkey\/valkey:[^ ]*\).*/\1/p' "$root/deploy/compose/prod.yml" | head -n 1)
echo "FROM $valkey" | docker build -q -t cenacle-smoke-valkey:local - >/dev/null
go -C "$root/server" build -o "$work/media-load" ./cmd/media-load

k3d cluster create "$cluster" --image "$k3s" --servers 1 --agents 0 --wait --timeout 180s \
  --k3s-arg '--disable=traefik@server:*' >/dev/null
for image in cenacle-media:smoke cenacle-smoke-valkey:local; do k3d image import "$image" -c "$cluster" >/dev/null; done
node=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "k3d-$cluster-server-0")
gateway=$(docker network inspect "k3d-$cluster" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
subnet=$(docker network inspect "k3d-$cluster" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
kubectl --context "k3d-$cluster" create namespace calls >/dev/null
kube create secret generic cenacle-calls --from-file=calls-public="$work/calls-public.pem" \
  --from-file=control-private="$work/control-private.pem" >/dev/null
kube create secret generic cenacle --from-literal=valkey-password= >/dev/null
# Valkey, and the chat server's control listener played by media-load on this host.
kube apply -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: { name: valkey }
spec:
  selector: { matchLabels: { app: valkey } }
  template:
    metadata: { labels: { app: valkey } }
    spec: { containers: [{ name: valkey, image: cenacle-smoke-valkey:local, imagePullPolicy: Never }] }
---
apiVersion: v1
kind: Service
metadata: { name: valkey }
spec: { selector: { app: valkey }, ports: [{ port: 6379 }] }
---
apiVersion: v1
kind: Service
metadata: { name: t-cenacle-server }
spec: { ports: [{ name: control, port: 7883 }] }
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata: { name: t-cenacle-server-host, labels: { kubernetes.io/service-name: t-cenacle-server } }
addressType: IPv4
ports: [{ name: control, port: 7883 }]
endpoints: [{ addresses: ["$gateway"] }]
YAML
kube rollout status deploy/valkey --timeout=120s >/dev/null

failed=0
port=27880
for exposure in hostPort loadBalancer hostNetwork; do
  port=$((port + 10)) # fresh local ports: a port-forward that is ending may still hold the last
  helm template t "$root/deploy/helm/cenacle" --namespace calls --show-only templates/media.yaml \
    --set calls.enabled=true --set calls.image=cenacle-media:smoke --set image.pullPolicy=Never \
    --set "calls.publicIP=$node" --set "calls.exposure=$exposure" --set "calls.callbackCIDRs[0]=$subnet" \
    --set "calls.nodeSelector.kubernetes\.io/hostname=k3d-$cluster-server-0" > "$work/media.yaml"
  kube apply -f "$work/media.yaml" >/dev/null
  # Readiness needs the control listener, which media-load is: wait until the pod
  # runs and holds its node lease, then call; the pod must be ready during the call.
  running=''
  for _ in $(seq 90); do
    if [ "$(kube get pods -l app.kubernetes.io/component=media -o jsonpath='{range .items[*]}{.status.phase}{" "}{end}')" = "Running " ] &&
      [ -n "$(kube exec deploy/valkey -- valkey-cli get cenacle:media:node:media-1 2>/dev/null)" ]; then
      running=1
      break
    fi
    sleep 2
  done
  if [ -z "$running" ]; then
    echo "FAIL $exposure: the media pod did not start"
    kube get pods -o wide
    failed=1
  else
    kube port-forward deploy/t-cenacle-media "$port:7880" >/dev/null 2>&1 &
    pids="$pids $!"
    kube port-forward svc/valkey "$((port + 1)):6379" >/dev/null 2>&1 &
    pids="$pids $!"
    sleep 3
    (sleep 15 && kube get pod -l app.kubernetes.io/component=media \
      -o jsonpath='{.items[0].status.containerStatuses[0].ready}' > "$work/ready") &
    probe=$!
    "$work/media-load" -origin https://chat.example.com -signal "ws://127.0.0.1:$port/media/ws" \
      -control 0.0.0.0:7883 -valkey "127.0.0.1:$((port + 1))" -calls-key "$work/calls-private.pem" \
      -control-key "$work/control-public.pem" -rooms 1 -people 3 -seconds 20 > "$work/report.json" 2> "$work/report.err" || true
    wait "$probe"
    if python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(not (not d['failures'] and d['received_streams_after_rejoin'] == d['expected_streams']))" "$work/report.json" 2>/dev/null &&
      [ "$(cat "$work/ready" 2>/dev/null)" = true ]; then
      echo "ok   $exposure"
    else
      echo "FAIL $exposure: $(tr -d '\n' < "$work/report.json" | cut -c1-300) $(tail -n 3 "$work/report.err")"
      failed=1
    fi
    for p in $pids; do kill "$p" 2>/dev/null || true; done
    pids=''
  fi
  kube delete -f "$work/media.yaml" --wait >/dev/null 2>&1 || true
  kube wait --for=delete pod -l app.kubernetes.io/component=media --timeout=60s >/dev/null 2>&1 || true
  sleep 16 # the node lease of the removed pod expires
done
[ "$failed" = 0 ] || exit 1
echo "the media service works with every calls.exposure"
