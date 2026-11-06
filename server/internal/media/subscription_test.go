// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"testing"

	"github.com/pion/rtp/codecs"
)

// Operator: go test ./internal/media -run TestRTPTranslation
func TestRTPTranslation(t *testing.T) {
	var translator rtpTranslator
	translator.switchSource(100, 90000)
	first, firstTS, frame, ok := translator.translate(100, 90000, 0, true)
	if !ok {
		t.Fatal("first frame rejected")
	}
	second, secondTS, same, ok := translator.translate(102, 90000, 0, false)
	if !ok || second != first+2 || secondTS != firstTS || same.picture != frame.picture {
		t.Fatal("packet gap or frame identity lost")
	}
	_, _, _, _ = translator.translate(103, 93000, 0, false)
	translator.switchSource(5000, 400000)
	switched, switchedTS, switchedFrame, ok := translator.translate(5000, 400000, 0, true)
	if !ok || switched != 104 || int32(switchedTS-secondTS) <= 0 || switchedFrame.picture == frame.picture {
		t.Fatal("layer switch broke RTP continuity")
	}
	payload := rewriteVP8(&codecs.VP8Packet{S: 1, L: 1, T: 1, Payload: []byte{0, 1, 2}}, switchedFrame)
	var decoded codecs.VP8Packet
	if _, err := decoded.Unmarshal(payload); err != nil || decoded.PictureID != switchedFrame.picture || decoded.TL0PICIDX != switchedFrame.tl0 {
		t.Fatal("invalid rewritten VP8 descriptor")
	}
}
