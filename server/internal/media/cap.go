// SPDX-License-Identifier: AGPL-3.0-only

//go:build !medialab

package media

// MaxParticipantsCap is the most people one room admits, whatever the chat
// server's policy says (workspaces choose up to it; 8 by default). 16 is what a
// 4 CPU / 8 GB media host was measured to carry (docs/operations/performance.md).
const MaxParticipantsCap = 16

// maxSubscriptions bounds the tracks one person receives: everyone else's audio
// and camera, one shared screen, and room for churn.
const maxSubscriptions = 2*MaxParticipantsCap + 8

// maxMediaSections bounds an SDP: a person's own three publications, everyone
// else's audio and camera, a shared screen, and sections still closing after
// people reconnect.
const maxMediaSections = 2*maxSubscriptions + 8

// MaxSDPBytes bounds one session description.
const MaxSDPBytes = 128 << 10
