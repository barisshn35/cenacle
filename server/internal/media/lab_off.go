// SPDX-License-Identifier: AGPL-3.0-only

//go:build !medialab

package media

import "net/http"

// LabHandler is nil in release builds (see lab.go).
func LabHandler(*SFU) http.Handler { return nil }

// labClosed is nil in release builds.
var labClosed func(*mediaPeer)

// labSignalEnded is nil in release builds.
var labSignalEnded func(SignalPeer, string)

// labOfferFailed is nil in release builds.
var labOfferFailed func(*mediaPeer, error)
