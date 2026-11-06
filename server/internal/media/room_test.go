// SPDX-License-Identifier: AGPL-3.0-only
package media

import "testing"

// A native sender may keep its SSRC/remote track across replaceTrack(null).
// Resuming it must reuse the source rather than wait for another OnTrack.
func TestPublicationResumesOnExistingRemoteTrack(t *testing.T) {
	peer := &mediaPeer{grant: Grant{ParticipantID: "participant"}, publications: map[string]string{}}
	key := "participant:camera"
	source := &publication{owner: peer, key: key, kind: "camera", remoteID: "stable-camera", layers: map[string]*inboundLayer{"q": {}, "h": {}, "f": {}}, subscribers: map[*subscription]bool{}}
	r := &room{peers: map[string]*mediaPeer{"participant": peer}, publications: map[string]*publication{key: source}, sources: map[string]*publication{key: source}}
	r.removePublication(peer, "camera")
	if !source.removed.Load() {
		t.Fatal("stopped camera remained published")
	}
	peer.publications["camera"] = "stable-camera"
	r.restorePublication(peer, "camera", "stable-camera")
	if source.removed.Load() || r.publications[key] != source || len(source.layers) != 3 {
		t.Fatal("camera did not resume on existing simulcast sources")
	}
}
func TestScreenSlotIsExclusive(t *testing.T) {
	a := &mediaPeer{grant: Grant{ParticipantID: "a"}}
	b := &mediaPeer{grant: Grant{ParticipantID: "b"}}
	r := &room{peers: map[string]*mediaPeer{"a": a, "b": b}, publications: map[string]*publication{}}
	if !r.claimScreen(a) || r.claimScreen(b) {
		t.Fatal("screen slot was not exclusive")
	}
	r.removePublication(a, "screen")
	if !r.claimScreen(b) {
		t.Fatal("screen slot was not released")
	}
}
