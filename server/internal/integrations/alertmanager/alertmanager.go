// SPDX-License-Identifier: Apache-2.0

// Package alertmanager turns Prometheus Alertmanager notifications (Grafana's
// alerting sends the same format) into a message card per notification.
package alertmanager

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/integrations"
)

type alert struct {
	Status       string            `json:"status"`
	Labels       map[string]string `json:"labels"`
	Annotations  map[string]string `json:"annotations"`
	GeneratorURL string            `json:"generatorURL"`
}

type notification struct {
	Status            string            `json:"status"`
	Receiver          string            `json:"receiver"`
	CommonLabels      map[string]string `json:"commonLabels"`
	CommonAnnotations map[string]string `json:"commonAnnotations"`
	ExternalURL       string            `json:"externalURL"`
	Alerts            []alert           `json:"alerts"`
}

// Card describes a notification; ok is false when it carries no alerts.
func Card(payload []byte) (api.Attachment, bool, error) {
	var n notification
	if err := json.Unmarshal(payload, &n); err != nil {
		return api.Attachment{}, false, fmt.Errorf("not an Alertmanager notification: %w", err)
	}
	if len(n.Alerts) == 0 {
		return api.Attachment{}, false, nil
	}
	firing := 0
	for _, a := range n.Alerts {
		if a.Status == "firing" {
			firing++
		}
	}
	name := n.CommonLabels["alertname"]
	if name == "" {
		name = n.Alerts[0].Labels["alertname"]
	}
	if name == "" {
		name = "Alert"
	}
	severity := n.CommonLabels["severity"]
	color := api.AttachmentColor("success")
	state := "RESOLVED"
	if firing > 0 {
		state = "FIRING"
		color = "warning"
		if severity == "critical" || severity == "page" {
			color = "danger"
		}
	}
	title := fmt.Sprintf("%s: %s", state, name)
	if len(n.Alerts) > 1 {
		title += fmt.Sprintf(" (%d)", len(n.Alerts))
	}
	summary := n.CommonAnnotations["summary"]
	if summary == "" {
		summary = n.Alerts[0].Annotations["summary"]
	}
	description := n.CommonAnnotations["description"]
	text := strings.TrimSpace(strings.Join([]string{summary, description}, "\n\n"))

	var fields []integrations.Field
	if severity != "" {
		fields = append(fields, integrations.ShortField("Severity", severity))
	}
	// The labels that tell the alerts apart (instance, job, …).
	keys := map[string]bool{}
	for _, a := range n.Alerts {
		for k := range a.Labels {
			if _, common := n.CommonLabels[k]; !common {
				keys[k] = true
			}
		}
	}
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	for _, k := range sorted {
		var values []string
		for _, a := range n.Alerts {
			if v := a.Labels[k]; v != "" {
				values = append(values, v)
			}
		}
		fields = append(fields, integrations.ShortField(k, strings.Join(values, ", ")))
	}
	link := n.Alerts[0].GeneratorURL
	if link == "" {
		link = n.ExternalURL
	}
	return integrations.Card(title, link, text, color, "Alertmanager", fields), true, nil
}
