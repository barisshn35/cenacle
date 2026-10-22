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
{{ printf "%s/%s%s:%s" .root.Values.image.registry .root.Values.image.prefix .component (.root.Values.image.tag | default .root.Chart.AppVersion) }}
{{- end -}}

{{- define "cenacle.podSecurity" -}}
runAsNonRoot: true
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "cenacle.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "cenacle.secret" -}}
valueFrom:
  secretKeyRef:
    name: {{ .root.Values.existingSecret }}
    key: {{ .key }}
{{- end -}}

{{/* Environment of the chat server (serve and migrate). */}}
{{- define "cenacle.serverEnv" -}}
- name: CENACLE_DATABASE_URL
  {{- include "cenacle.secret" (dict "root" . "key" "chat-database-url") | nindent 2 }}
- name: CENACLE_VALKEY_ADDR
  value: {{ .Values.valkey.addr | quote }}
- name: CENACLE_VALKEY_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.existingSecret }}, key: valkey-password, optional: true }
{{- end -}}
