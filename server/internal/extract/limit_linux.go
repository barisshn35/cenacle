// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package extract

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// childAttr: the child starts in a process group of its own, so a signal
// meant for the server's group does not reach it half-way.
func childAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }

// limitChild caps the child's own process: memory it may add (writable
// data, and the address space it already has plus that), CPU seconds (then
// the kernel kills it), no core dumps and no files written.
func limitChild(memory, cpu uint64) error {
	limits := []struct {
		res int
		val uint64
	}{
		{syscall.RLIMIT_DATA, memory},
		{syscall.RLIMIT_CPU, cpu},
		{syscall.RLIMIT_CORE, 0},
		{syscall.RLIMIT_FSIZE, 0},
	}
	if vm, ok := addressSpace(); ok {
		limits = append(limits, struct {
			res int
			val uint64
		}{syscall.RLIMIT_AS, vm + memory})
	}
	for _, l := range limits {
		if err := syscall.Setrlimit(l.res, &syscall.Rlimit{Cur: l.val, Max: l.val}); err != nil {
			return err
		}
	}
	return nil
}

// addressSpace is the size of the process's address space now (VmSize):
// the Go runtime reserves much of it at start without using it.
func addressSpace() (uint64, bool) {
	f, err := os.Open("/proc/self/status")
	if err != nil {
		return 0, false
	}
	defer func() { _ = f.Close() }()
	s := bufio.NewScanner(f)
	for s.Scan() {
		if v, ok := strings.CutPrefix(s.Text(), "VmSize:"); ok {
			kb, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(v), " kB"), 10, 64)
			return kb << 10, err == nil
		}
	}
	return 0, false
}
