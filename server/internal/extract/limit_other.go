// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux

package extract

import "syscall"

func childAttr() *syscall.SysProcAttr { return nil }

// limitChild: other systems keep the wall-clock limit only.
func limitChild(memory, cpu uint64) error { return nil }
