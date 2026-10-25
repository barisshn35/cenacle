// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// End-to-end encryption with device keys (MLS, RFC 9420). The server is the
// delivery service: it never sees keys or texts. It keeps devices' public
// keys, orders each channel group's commits by epoch (the first commit for an
// epoch wins), keeps the newest GroupInfo so a member's device joins on its
// own (an external commit), and tells members' devices which devices to
// remove (revoked ones, and those of people who left the channel).

const (
	CodeEpochConflict = "epoch_conflict"
	CodeTooManyDevice = "too_many_devices"
	CodeNoDevice      = "unknown_device"
	CodeBackupFull    = "backup_full"
	CodeEscrowNeeded  = "escrow_required"

	maxDevices     = 20
	maxBackupBytes = 512 << 20 // per person
	mlsBodyMax     = 32000
)

// mlsEnvelopeRE is an MLS application message: "mls:v1:<base64 MLSMessage>".
var mlsEnvelopeRE = regexp.MustCompile(`^mls:v1:[A-Za-z0-9+/]+={0,2}$`)

func isMLSEnvelope(s string) bool { return len(s) <= mlsBodyMax && mlsEnvelopeRE.MatchString(s) }

// mlsHeader reads the group id and epoch an MLS PrivateMessage carries in the
// clear (RFC 9420 §6: MLSMessage = version, wire_format, then for a
// PrivateMessage group_id<V> and epoch).
func mlsHeader(envelope string) (group []byte, epoch uint64, ok bool) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(envelope, "mls:v1:"))
	if err != nil || len(raw) < 5 {
		return nil, 0, false
	}
	const mls10, privateMessage = 1, 2
	if binary.BigEndian.Uint16(raw) != mls10 || binary.BigEndian.Uint16(raw[2:]) != privateMessage {
		return nil, 0, false
	}
	rest := raw[4:]
	n, size, ok := mlsVarint(rest)
	if !ok || n > 255 {
		return nil, 0, false
	}
	idLen := int(n) //nolint:gosec // at most 255, checked above
	if len(rest) < size+idLen+8 {
		return nil, 0, false
	}
	rest = rest[size:]
	return rest[:idLen], binary.BigEndian.Uint64(rest[idLen:]), true
}

// mlsVarint reads a variable-size length (RFC 9000 §16, as MLS uses it).
func mlsVarint(b []byte) (value uint64, size int, ok bool) {
	if len(b) == 0 {
		return 0, 0, false
	}
	size = 1 << (b[0] >> 6)
	if size > 4 || len(b) < size {
		return 0, 0, false
	}
	value = uint64(b[0] & 0x3f)
	for _, x := range b[1:size] {
		value = value<<8 | uint64(x)
	}
	return value, size, true
}

// mlsEpochOK answers for an envelope that is not for the group's current
// epoch (409: the client updates its group and seals again).
func (h *Handlers) mlsEpochOK(w http.ResponseWriter, r *http.Request, c store.Channel, body string) bool {
	ok, stale, err := h.mlsCurrent(r.Context(), c, body)
	switch {
	case err != nil:
		h.unavailable(w, r, "load group", err)
	case stale:
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeEpochConflict,
			Detail: "The group changed: update it and seal the message again."})
	case !ok:
		refuseEncrypted(w, r)
	}
	return err == nil && ok
}

// mlsCurrent checks an envelope against its channel's group: the channel's
// group id at the group's current epoch (an older epoch is refused, so that
// devices that joined since can read every message).
func (h *Handlers) mlsCurrent(ctx context.Context, c store.Channel, body string) (ok bool, stale bool, err error) {
	group, epoch, ok := mlsHeader(body)
	if !ok || string(group) != uuid(c.ID).String() {
		return false, false, nil
	}
	g, err := h.Queries.GetMLSGroup(ctx, c.ID)
	if err != nil {
		return false, false, err
	}
	return epoch == uint64(g.Epoch), epoch < uint64(g.Epoch), nil //nolint:gosec // epochs are not negative
}

func deviceAPI(d store.E2eDevice, own bool) api.E2EDevice {
	out := api.E2EDevice{
		Id: uuid(d.ID), UserId: uuid(d.UserID), Name: d.Name, SignatureKey: d.SignatureKey, CreatedAt: d.CreatedAt,
	}
	if own {
		out.LastSeenAt = &d.LastSeenAt
	}
	return out
}

// ListE2EDevices implements api.ServerInterface.
func (h *Handlers) ListE2EDevices(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListActiveDevices(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list devices", err)
		return
	}
	out := make([]api.E2EDevice, 0, len(rows))
	for _, d := range rows {
		out = append(out, deviceAPI(d, true))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Devices []api.E2EDevice `json:"devices"`
	}{out})
}

// RegisterE2EDevice implements api.ServerInterface.
func (h *Handlers) RegisterE2EDevice(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.RegisterE2EDeviceJSONRequestBody
	if !decode(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || len([]rune(name)) > 80 || len(in.SignatureKey) != 32 {
		badRequest(w, r, "A device needs a name (up to 80 characters) and a 32-byte Ed25519 public key.")
		return
	}
	n, err := h.Queries.CountActiveDevices(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "count devices", err)
		return
	}
	if n >= maxDevices {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeTooManyDevice,
			Detail: "You have 20 devices with encryption keys; remove one first."})
		return
	}
	d, err := h.Queries.CreateDevice(r.Context(), store.CreateDeviceParams{UserID: p.User.ID, Name: name, SignatureKey: in.SignatureKey})
	if err != nil {
		h.unavailable(w, r, "create device", err)
		return
	}
	h.Audit.Record(context.WithoutCancel(r.Context()), audit.Event{Actor: p.User.ID, Action: audit.E2EDeviceAdded,
		TargetType: "device", TargetID: uuid(d.ID).String(), Detail: map[string]any{"name": name}})
	httpx.WriteJSON(w, http.StatusCreated, deviceAPI(d, true))
}

// RevokeE2EDevice implements api.ServerInterface.
func (h *Handlers) RevokeE2EDevice(w http.ResponseWriter, r *http.Request, deviceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	d, err := h.Queries.RevokeDevice(r.Context(), store.RevokeDeviceParams{ID: pgUUID(deviceID), UserID: p.User.ID})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such device."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "revoke device", err)
		return
	}
	h.Audit.Record(context.WithoutCancel(r.Context()), audit.Event{Actor: p.User.ID, Action: audit.E2EDeviceRevoked,
		TargetType: "device", TargetID: uuid(d.ID).String(), Detail: map[string]any{"name": d.Name}})
	// The groups it is in remove it with their next commit.
	if channels, err := h.Queries.ChannelsOfDevice(r.Context(), d.ID); err == nil {
		for _, c := range channels {
			h.publish(r.Context(), events.E2EChanged, map[string]any{"channel_id": uuid(c).String()})
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListUserE2EDevices implements api.ServerInterface.
func (h *Handlers) ListUserE2EDevices(w http.ResponseWriter, r *http.Request, userID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	// Only the devices of people one can see (as for profiles).
	visible, err := h.Queries.VisibleProfileIDs(r.Context(), store.VisibleProfileIDsParams{Ids: []pgtype.UUID{pgUUID(userID)}, Viewer: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "visible profiles", err)
		return
	}
	if len(visible) == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such person."})
		return
	}
	rows, err := h.Queries.ListUserDevicesFor(r.Context(), visible)
	if err != nil {
		h.unavailable(w, r, "list devices", err)
		return
	}
	out := make([]api.E2EDevice, 0, len(rows))
	for _, d := range rows {
		dev := deviceAPI(store.E2eDevice{
			ID: d.ID, UserID: d.UserID, Name: d.Name, SignatureKey: d.SignatureKey, CreatedAt: d.CreatedAt,
		}, false)
		if d.RevokedAt.Valid {
			dev.RevokedAt = &d.RevokedAt.Time
		}
		out = append(out, dev)
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Devices []api.E2EDevice `json:"devices"`
	}{out})
}

// mlsChannel loads an MLS channel the person is a member of.
func (h *Handlers) mlsChannel(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Channel, access, bool) {
	c, a, ok := h.memberChannel(w, r, id, user)
	if !ok {
		return c, a, false
	}
	if !c.Mls {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "This channel is not encrypted with device keys."})
		return c, a, false
	}
	return c, a, true
}

// ownDevice checks that a device is the person's and active.
func (h *Handlers) ownDevice(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.E2eDevice, bool) {
	d, err := h.Queries.GetActiveDevice(r.Context(), store.GetActiveDeviceParams{ID: pgUUID(id), UserID: user.ID})
	if isNoRows(err) {
		forbidden(w, r, CodeNoDevice, "This device is not registered (or was removed); register it again.")
		return d, false
	}
	if err != nil {
		h.unavailable(w, r, "load device", err)
		return d, false
	}
	_ = h.Queries.TouchDevice(r.Context(), d.ID)
	return d, true
}

func (h *Handlers) mlsGroupAPI(ctx context.Context, channel pgtype.UUID) (api.MLSGroup, error) {
	g, err := h.Queries.GetMLSGroup(ctx, channel)
	if err != nil {
		return api.MLSGroup{}, err
	}
	members, err := h.Queries.ListMLSMembers(ctx, channel)
	if err != nil {
		return api.MLSGroup{}, err
	}
	out := api.MLSGroup{Epoch: g.Epoch, GroupInfo: g.GroupInfo, Members: make([]struct {
		DeviceId    openapi_types.UUID `json:"device_id"`
		JoinedEpoch int64              `json:"joined_epoch"`
		Stale       bool               `json:"stale"`
		UserId      openapi_types.UUID `json:"user_id"`
	}, 0, len(members))}
	for _, m := range members {
		out.Members = append(out.Members, struct {
			DeviceId    openapi_types.UUID `json:"device_id"`
			JoinedEpoch int64              `json:"joined_epoch"`
			Stale       bool               `json:"stale"`
			UserId      openapi_types.UUID `json:"user_id"`
		}{uuid(m.DeviceID), m.JoinedEpoch, m.Stale, uuid(m.UserID)})
	}
	return out, nil
}

// GetMLSGroup implements api.ServerInterface.
func (h *Handlers) GetMLSGroup(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, ok := h.mlsChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	out, err := h.mlsGroupAPI(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "load group", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// EnableMLS implements api.ServerInterface.
func (h *Handlers) EnableMLS(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.EnableMLSJSONRequestBody
	if !decodeLimit(w, r, &in, 1<<20) {
		return
	}
	c, a, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if !isConversation(c) && !canManage(c, a) {
		forbidden(w, r, httpx.CodeForbidden, "Only the channel's managers turn on encryption.")
		return
	}
	if c.Encrypted {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeEncrypted,
			Detail: "This channel is encrypted already."})
		return
	}
	if len(in.GroupInfo) == 0 {
		badRequest(w, r, "The group's GroupInfo is missing.")
		return
	}
	// A forum's posts have titles, which the server would read.
	if c.Kind == KindForum {
		badRequest(w, r, "A forum cannot be encrypted with device keys.")
		return
	}
	if shares, err := h.Queries.ActiveSharesOfChannel(r.Context(), c.ID); err != nil {
		h.unavailable(w, r, "load shares", err)
		return
	} else if len(shares) > 0 {
		badRequest(w, r, "A channel shared with other servers cannot be encrypted with device keys.")
		return
	}
	d, ok := h.ownDevice(w, r, in.DeviceId, p.User)
	if !ok {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		n, err := q.EnableMLS(r.Context(), c.ID)
		if err != nil {
			return err
		}
		if n == 0 {
			return errEncrypted
		}
		if err := q.CreateMLSGroup(r.Context(), store.CreateMLSGroupParams{ChannelID: c.ID, GroupInfo: in.GroupInfo}); err != nil {
			return err
		}
		return q.AddMLSMember(r.Context(), store.AddMLSMemberParams{ChannelID: c.ID, DeviceID: d.ID, JoinedEpoch: 0})
	})
	if errors.Is(err, errEncrypted) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeEncrypted,
			Detail: "This channel is encrypted already."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "enable encryption", err)
		return
	}
	h.Audit.Record(context.WithoutCancel(r.Context()), audit.Event{Actor: p.User.ID, Workspace: c.WorkspaceID,
		Action: audit.E2EEnabled, TargetType: "channel", TargetID: uuid(c.ID).String(), Detail: map[string]any{"channel": c.Name}})
	c.Encrypted, c.Mls = true, true
	h.publish(r.Context(), events.ChannelUpdated, map[string]any{"channel_id": uuid(c.ID).String(), "channel": toAPI(c, a)})
	out, err := h.mlsGroupAPI(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "load group", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ListMLSCommits implements api.ServerInterface.
func (h *Handlers) ListMLSCommits(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID, params api.ListMLSCommitsParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, ok := h.mlsChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListMLSCommits(r.Context(), store.ListMLSCommitsParams{ChannelID: c.ID, FromEpoch: params.FromEpoch})
	if err != nil {
		h.unavailable(w, r, "list commits", err)
		return
	}
	out := make([]api.MLSCommit, 0, len(rows))
	for _, m := range rows {
		cm := api.MLSCommit{Epoch: m.Epoch, Data: m.Data}
		if m.DeviceID.Valid {
			id := uuid(m.DeviceID)
			cm.DeviceId = &id
		}
		out = append(out, cm)
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Commits []api.MLSCommit `json:"commits"`
	}{out})
}

// SendMLSCommit implements api.ServerInterface.
func (h *Handlers) SendMLSCommit(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SendMLSCommitJSONRequestBody
	if !decodeLimit(w, r, &in, 2<<20) {
		return
	}
	c, _, ok := h.mlsChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if len(in.Commit) == 0 || len(in.GroupInfo) == 0 {
		badRequest(w, r, "A commit needs its data and the new GroupInfo.")
		return
	}
	d, ok := h.ownDevice(w, r, in.DeviceId, p.User)
	if !ok {
		return
	}
	members, err := h.Queries.ListMLSMembers(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "load group", err)
		return
	}
	inGroup := slices.ContainsFunc(members, func(m store.ListMLSMembersRow) bool { return m.DeviceID == d.ID })
	joined := in.Joined != nil && *in.Joined
	if !joined && !inGroup {
		// A device in the group commits; one outside joins with an external commit
		// (also to rejoin when it lost its state).
		forbidden(w, r, CodeNoDevice, "This device is not in the group: join it first.")
		return
	}
	var removed []pgtype.UUID
	if in.Removed != nil {
		for _, id := range *in.Removed {
			removed = append(removed, pgUUID(id))
		}
	}
	var next int64
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		next, err = q.AdvanceMLSGroup(r.Context(), store.AdvanceMLSGroupParams{ChannelID: c.ID, Epoch: in.Epoch, GroupInfo: in.GroupInfo})
		if err != nil {
			return err
		}
		if err := q.InsertMLSCommit(r.Context(), store.InsertMLSCommitParams{
			ChannelID: c.ID, Epoch: in.Epoch, DeviceID: d.ID, Data: in.Commit,
		}); err != nil {
			return err
		}
		if len(removed) > 0 {
			if err := q.RemoveMLSMembers(r.Context(), store.RemoveMLSMembersParams{ChannelID: c.ID, DeviceIds: removed}); err != nil {
				return err
			}
		}
		if joined {
			return q.AddMLSMember(r.Context(), store.AddMLSMemberParams{ChannelID: c.ID, DeviceID: d.ID, JoinedEpoch: next})
		}
		return nil
	})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeEpochConflict,
			Detail: "Another change came first: apply the group's newer commits and try again."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "store commit", err)
		return
	}
	h.publish(r.Context(), events.E2EChanged, map[string]any{"channel_id": uuid(c.ID).String(), "epoch": next})
	out, err := h.mlsGroupAPI(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "load group", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

// ------------------------------------------------- recovery and backups ---

func escrowAPI(k store.E2eEscrow) *api.E2EEscrowKey {
	return &api.E2EEscrowKey{KeyId: k.KeyID, PublicKey: k.PublicKey}
}

func (h *Handlers) recoveryAPI(ctx context.Context, user pgtype.UUID) (api.E2ERecovery, error) {
	var out api.E2ERecovery
	esc, err := h.Queries.GetEscrowKey(ctx)
	if err != nil && !isNoRows(err) {
		return out, err
	}
	if err == nil {
		out.EscrowKey = escrowAPI(esc)
	}
	rec, err := h.Queries.GetRecovery(ctx, user)
	if isNoRows(err) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	out.Set = true
	out.Verifier = &rec.Verifier
	escrowed := out.EscrowKey != nil && rec.EscrowKeyID.Valid && rec.EscrowKeyID.String == out.EscrowKey.KeyId
	out.Escrowed = &escrowed
	return out, nil
}

// GetE2ERecovery implements api.ServerInterface.
func (h *Handlers) GetE2ERecovery(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	out, err := h.recoveryAPI(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "load recovery", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// SetE2ERecovery implements api.ServerInterface.
func (h *Handlers) SetE2ERecovery(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetE2ERecoveryJSONRequestBody
	if !decode(w, r, &in) {
		return
	}
	if len(in.Verifier) != 32 {
		badRequest(w, r, "The verifier is an HMAC-SHA-256 (32 bytes).")
		return
	}
	esc, err := h.Queries.GetEscrowKey(r.Context())
	if err != nil && !isNoRows(err) {
		h.unavailable(w, r, "load escrow key", err)
		return
	}
	params := store.SetRecoveryParams{UserID: p.User.ID, Verifier: in.Verifier}
	if err == nil {
		if in.Escrow == nil || len(*in.Escrow) == 0 || len(*in.Escrow) > 1024 || in.EscrowKeyId == nil || *in.EscrowKeyId != esc.KeyID {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: CodeEscrowNeeded,
				Detail: "Your organization keeps a copy of recovery keys: seal it for the current escrow key."})
			return
		}
		params.Escrow = *in.Escrow
		params.EscrowKeyID = pgtype.Text{String: esc.KeyID, Valid: true}
	}
	// A new key cannot open the old backups: they go.
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.DeleteRecovery(r.Context(), p.User.ID); err != nil {
			return err
		}
		_, err := q.SetRecovery(r.Context(), params)
		return err
	})
	if err != nil {
		h.unavailable(w, r, "set recovery", err)
		return
	}
	out, err := h.recoveryAPI(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "load recovery", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// DeleteE2ERecovery implements api.ServerInterface.
func (h *Handlers) DeleteE2ERecovery(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if err := h.Queries.DeleteRecovery(r.Context(), p.User.ID); err != nil {
		h.unavailable(w, r, "delete recovery", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListE2EBackups implements api.ServerInterface.
func (h *Handlers) ListE2EBackups(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID, params api.ListE2EBackupsParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, ok := h.mlsChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	after := pgtype.UUID{Valid: true}
	if params.After != nil {
		after = pgUUID(*params.After)
	}
	rows, err := h.Queries.ListBackups(r.Context(), store.ListBackupsParams{UserID: p.User.ID, ChannelID: c.ID, After: after})
	if err != nil {
		h.unavailable(w, r, "list backups", err)
		return
	}
	type backup struct {
		ID   openapi_types.UUID `json:"id"`
		Data []byte             `json:"data"`
	}
	out := make([]backup, 0, len(rows))
	for _, b := range rows {
		out = append(out, backup{uuid(b.ID), b.Data})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Backups []backup `json:"backups"`
	}{out})
}

// AddE2EBackup implements api.ServerInterface.
func (h *Handlers) AddE2EBackup(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.AddE2EBackupJSONRequestBody
	if !decodeLimit(w, r, &in, 2<<20) {
		return
	}
	c, _, ok := h.mlsChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if len(in.Data) == 0 || len(in.Data) > 1<<20 {
		badRequest(w, r, "A backup holds 1 byte to 1 MiB.")
		return
	}
	if _, err := h.Queries.GetRecovery(r.Context(), p.User.ID); isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: httpx.CodeBadRequest,
			Detail: "Set up a recovery key first."})
		return
	} else if err != nil {
		h.unavailable(w, r, "load recovery", err)
		return
	}
	used, err := h.Queries.CountBackupBytes(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "count backups", err)
		return
	}
	if used+int64(len(in.Data)) > maxBackupBytes {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusRequestEntityTooLarge, Code: CodeBackupFull,
			Detail: "Your history backup is full (512 MiB)."})
		return
	}
	if _, err := h.Queries.InsertBackup(r.Context(), store.InsertBackupParams{UserID: p.User.ID, ChannelID: c.ID, Data: in.Data}); err != nil {
		h.unavailable(w, r, "store backup", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SetE2EEscrowKey implements api.ServerInterface.
func (h *Handlers) SetE2EEscrowKey(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	var in api.SetE2EEscrowKeyJSONRequestBody
	if !decode(w, r, &in) {
		return
	}
	key, err := x509.ParsePKIXPublicKey(in.PublicKey)
	ec, isEC := key.(*ecdsa.PublicKey)
	if err != nil || !isEC || ec.Curve.Params().Name != "P-256" || strings.TrimSpace(in.KeyId) == "" {
		badRequest(w, r, "The escrow key is a P-256 public key (SPKI, DER) with an id.")
		return
	}
	k, err := h.Queries.SetEscrowKey(r.Context(), store.SetEscrowKeyParams{KeyID: strings.TrimSpace(in.KeyId), PublicKey: in.PublicKey})
	if err != nil {
		h.unavailable(w, r, "set escrow key", err)
		return
	}
	h.Audit.Record(context.WithoutCancel(r.Context()), audit.Event{Actor: p.User.ID, Action: audit.E2EEscrowChanged,
		TargetType: "instance", Detail: map[string]any{"key_id": k.KeyID,
			"public_key": base64.StdEncoding.EncodeToString(k.PublicKey)}})
	httpx.WriteJSON(w, http.StatusOK, escrowAPI(k))
}

// DeleteE2EEscrowKey implements api.ServerInterface.
func (h *Handlers) DeleteE2EEscrowKey(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	if err := h.Queries.DeleteEscrowKey(r.Context()); err != nil {
		h.unavailable(w, r, "delete escrow key", err)
		return
	}
	h.Audit.Record(context.WithoutCancel(r.Context()), audit.Event{Actor: p.User.ID, Action: audit.E2EEscrowChanged,
		TargetType: "instance", Detail: map[string]any{"key_id": nil}})
	w.WriteHeader(http.StatusNoContent)
}
