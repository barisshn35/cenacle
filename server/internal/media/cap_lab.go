// SPDX-License-Identifier: AGPL-3.0-only

//go:build medialab

package media

// Capacity measurements only (go build -tags medialab): rooms up to 25 people,
// so 16 and 25 can be measured. Never in a release image.
const MaxParticipantsCap = 25

// maxSubscriptions bounds the tracks one person receives: everyone else's audio
// and camera, one shared screen, and room for churn.
const maxSubscriptions = 2*MaxParticipantsCap + 8

// maxMediaSections bounds an SDP: a person's own three publications, everyone
// else's audio and camera, a shared screen, and sections still closing after
// people reconnect.
const maxMediaSections = 2*maxSubscriptions + 8

// MaxSDPBytes bounds one session description (rooms of 25 need larger descriptions).
const MaxSDPBytes = 192 << 10
