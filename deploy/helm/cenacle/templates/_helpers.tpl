{{/* SPDX-License-Identifier: AGPL-3.0-only */}}
{{- define "cenacle.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 50 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "cenacle.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "cenacle.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "cenacle.image" -}}
{{- $fips := and .root.Values.image.fips (has .component (list "server" "idp")) -}}
{{ printf "%s/%s%s%s:%s" .root.Values.image.registry .root.Values.image.prefix .component (ternary "-fips" "" $fips) (.root.Values.image.tag | default .root.Chart.AppVersion) }}
{{- end -}}

{{/* Pod security for the image's user id (server 65532, idp 1000, web 10001):
     numeric ids, so the kubelet can check runAsNonRoot; fsGroup makes mounted
     volumes writable for it. */}}
{{- define "cenacle.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ . }}
runAsGroup: {{ . }}
fsGroup: {{ . }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "cenacle.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{/* Where files are kept: files.backend, or s3 when s3.endpoint is set; "" off. */}}
{{- define "cenacle.filesBackend" -}}
{{- $backend := .Values.files.backend | default (ternary "s3" "" (ne .Values.s3.endpoint "")) -}}
{{- if ne $backend "off" }}{{ $backend }}{{ end -}}
{{- end -}}

{{/* Environment of the chat server (serve and migrate). Secrets are files of
     the "secrets" volume (cenacle.serverSecrets), not environment variables.
     The optional valkey-password stays a variable: a missing key cannot be a
     missing file without hiding typos in the paths. */}}
{{- define "cenacle.serverEnv" -}}
- { name: CENACLE_DATABASE_URL_FILE, value: /run/secrets/cenacle/chat-database-url }
- name: CENACLE_VALKEY_ADDR
  value: {{ .Values.valkey.addr | quote }}
- name: CENACLE_VALKEY_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.existingSecret }}, key: valkey-password, optional: true }
{{- end -}}


{{/* The secrets volume of the chat server; with serve, the keys of the HTTP
     server and its files backend too. */}}
{{- define "cenacle.serverSecrets" -}}
- name: secrets
  secret:
    secretName: {{ .root.Values.existingSecret }}
    items:
      - { key: chat-database-url, path: chat-database-url }
      {{- if .serve }}
      - { key: chat-client-secret, path: chat-client-secret }
      {{- $files := include "cenacle.filesBackend" .root }}
      {{- if eq $files "s3" }}
      - { key: s3-access-key, path: s3-access-key }
      - { key: s3-secret-key, path: s3-secret-key }
      {{- else if eq $files "azure" }}
      - { key: azure-key, path: azure-key }
      {{- end }}
      {{- end }}
{{- end -}}
