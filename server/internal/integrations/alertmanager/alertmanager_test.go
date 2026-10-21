// SPDX-License-Identifier: Apache-2.0

package alertmanager_test

import (
	"testing"

	"github.com/barisshn35/cenacle/server/internal/integrations/alertmanager"
)

func TestCards(t *testing.T) {
	firing, ok, err := alertmanager.Card([]byte(`{"status": "firing", "commonLabels": {"alertname": "DiskFull", "severity": "critical"},
	  "commonAnnotations": {"summary": "Disk almost full"},
	  "alerts": [{"status": "firing", "labels": {"alertname": "DiskFull", "instance": "db-1"}, "generatorURL": "https://grafana.example.com/x"},
	             {"status": "firing", "labels": {"alertname": "DiskFull", "instance": "db-2"}}]}`))
	if err != nil || !ok {
		t.Fatalf("%v %v", ok, err)
	}
	if *firing.Title != "FIRING: DiskFull (2)" || *firing.Color != "danger" || *firing.Text != "Disk almost full" {
		t.Errorf("firing = %+v", firing)
	}
	fields := *firing.Fields
	if len(fields) != 2 || fields[1].Title != "instance" || fields[1].Value != "db-1, db-2" {
		t.Errorf("fields = %+v", fields)
	}
	resolved, _, _ := alertmanager.Card([]byte(`{"status": "resolved", "commonLabels": {"alertname": "DiskFull"}, "alerts": [{"status": "resolved", "labels": {}}]}`))
	if *resolved.Title != "RESOLVED: DiskFull" || *resolved.Color != "success" {
		t.Errorf("resolved = %+v", resolved)
	}
	if _, ok, _ := alertmanager.Card([]byte(`{"alerts": []}`)); ok {
		t.Error("empty notification posted")
	}
}
