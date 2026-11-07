// SPDX-License-Identifier: AGPL-3.0-only

// Package deployfiles checks the deployment files (deploy/compose) for
// mistakes Docker only reports when a stack starts.
package deployfiles

import (
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

type composeFile struct {
	Services map[string]struct {
		Tmpfs any `yaml:"tmpfs"`
		// A list of names, or a map of names to their settings.
		Networks any `yaml:"networks"`
	} `yaml:"services"`
	Networks map[string]struct {
		Ipam struct {
			Config []struct {
				Subnet  string `yaml:"subnet"`
				IPRange string `yaml:"ip_range"`
			} `yaml:"config"`
		} `yaml:"ipam"`
	} `yaml:"networks"`
}

func composeFiles(t *testing.T) map[string]composeFile {
	t.Helper()
	paths, err := filepath.Glob("../../../deploy/compose/*.yml")
	if err != nil || len(paths) == 0 {
		t.Fatalf("no compose files: %v", err)
	}
	out := map[string]composeFile{}
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		var f composeFile
		if err := yaml.Unmarshal(raw, &f); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		out[filepath.Base(p)] = f
	}
	return out
}

// Every tmpfs entry is one absolute path with its options: a flow list
// splits "/tmp:size=16m, noexec" into entries Docker refuses ("noexec").
func TestComposeTmpfsEntries(t *testing.T) {
	for name, f := range composeFiles(t) {
		for svc, s := range f.Services {
			var entries []string
			switch v := s.Tmpfs.(type) {
			case nil:
			case string:
				entries = []string{v}
			case []any:
				for _, e := range v {
					str, _ := e.(string)
					entries = append(entries, str)
				}
			default:
				t.Errorf("%s: %s: tmpfs is %T", name, svc, v)
			}
			for _, e := range entries {
				if !strings.HasPrefix(e, "/") || strings.Contains(e, " ") {
					t.Errorf("%s: %s: tmpfs entry %q is not one absolute path with its options", name, svc, e)
				}
			}
		}
	}
}

// A fixed address must stay out of the range Docker hands out to the other
// containers of its network, or one of them can take it first.
func TestComposeFixedAddressesReserved(t *testing.T) {
	files := composeFiles(t)
	for name, f := range files {
		for svc, s := range f.Services {
			nets, _ := s.Networks.(map[string]any)
			for netName, cfg := range nets {
				m, _ := cfg.(map[string]any)
				addr, _ := m["ipv4_address"].(string)
				if addr == "" {
					continue
				}
				ip, err := netip.ParseAddr(addr)
				if err != nil {
					t.Errorf("%s: %s: ipv4_address %q: %v", name, svc, addr, err)
					continue
				}
				found := false
				for _, other := range files {
					n, ok := other.Networks[netName]
					if !ok {
						continue
					}
					for _, c := range n.Ipam.Config {
						subnet, err1 := netip.ParsePrefix(c.Subnet)
						if err1 != nil || !subnet.Contains(ip) {
							continue
						}
						found = true
						r, err2 := netip.ParsePrefix(c.IPRange)
						switch {
						case err2 != nil:
							t.Errorf("%s: network %s has no ip_range: %s's %s can be taken by another container", name, netName, svc, addr)
						case r.Contains(ip):
							t.Errorf("%s: %s's %s lies inside ip_range %s of %s", name, svc, addr, c.IPRange, netName)
						}
					}
				}
				if !found {
					t.Errorf("%s: %s: no subnet of network %s holds %s", name, svc, netName, addr)
				}
			}
		}
	}
}
