// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Codes and limits of compliance and access control.
const (
	CodeEncrypted       = "encrypted_channel"
	CodeAccessRules     = "access_rules"
	retentionBatch      = 5000
	exportPage          = 1000
	maxAttributeValueRn = 100
)

// envelopeRE is an end-to-end encrypted body: "e2e:v1:<iv>:<ciphertext>",
// base64 (a 12-byte nonce, then the AES-GCM ciphertext with its tag).
var envelopeRE = regexp.MustCompile(`^e2e:v1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22,}={0,2}$`)

func isEnvelope(s string) bool { return len(s) <= 12000 && envelopeRE.MatchString(s) }

// keyCheckRE is an encrypted channel's key check: the random salt of its key
// ("s:<16 bytes, base64>:"), then a known text sealed with the key.
var keyCheckRE = regexp.MustCompile(`^s:[A-Za-z0-9+/]{22}==:(e2e:v1:.*)$`)

func isKeyCheck(s string) bool {
	m := keyCheckRE.FindStringSubmatch(s)
	return len(s) <= 400 && m != nil && isEnvelope(m[1])
}

var errEncrypted = errors.New("encrypted channel")

// encryptedBody checks a body for a channel: encrypted channels take
// envelopes only (or nothing, with a sticker); others never take envelopes.
func encryptedBody(c store.Channel, body string) bool {
	if c.Encrypted {
		return body == "" || isEnvelope(body)
	}
	return !strings.HasPrefix(body, "e2e:v1:")
}

func refuseEncrypted(w http.ResponseWriter, r *http.Request) {
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: CodeEncrypted,
		Detail: "This channel is encrypted end to end: only its members' apps write in it."})
}

func accessRules(c store.Channel) []api.AccessRule {
	out := []api.AccessRule{}
	_ = json.Unmarshal(c.AccessRules, &out)
	return out
}

// meetsRules: a member needs one of the values of every rule (case does not matter).
func meetsRules(rules []api.AccessRule, attrs map[string]string) bool {
	for _, rule := range rules {
		v := strings.ToLower(strings.TrimSpace(attrs[rule.Key]))
		if v == "" || !slices.ContainsFunc(rule.Values, func(x string) bool { return strings.ToLower(x) == v }) {
			return false
		}
	}
	return true
}

func attributesOf(raw []byte) map[string]string {
	out := map[string]string{}
	_ = json.Unmarshal(raw, &out)
	return out
}

// mayJoin answers 403 when a user does not meet a channel's access rules.
func (h *Handlers) mayJoin(w http.ResponseWriter, r *http.Request, c store.Channel, user pgtype.UUID) bool {
	rules := accessRules(c)
	if len(rules) == 0 {
		return true
	}
	raw, err := h.Queries.GetMemberAttributes(r.Context(), store.GetMemberAttributesParams{WorkspaceID: c.WorkspaceID, UserID: user})
	if err != nil && !isNoRows(err) {
		h.unavailable(w, r, "get attributes", err)
		return false
	}
	if !meetsRules(rules, attributesOf(raw)) {
		forbidden(w, r, CodeAccessRules, "This channel is for members with certain attributes (e.g. department).")
		return false
	}
	return true
}

func (h *Handlers) requireWorkspaceOwner(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User, detail string) bool {
	role, ok := h.workspaceRole(w, r, id, user)
	if ok && role != WorkspaceOwner {
		forbidden(w, r, httpx.CodeForbidden, detail)
		return false
	}
	return ok
}

// --- workspace settings -------------------------------------------------------

func classificationAPI(c store.Classification) api.Classification {
	id := uuid(c.ID)
	return api.Classification{Id: &id, Name: c.Name, Description: c.Description, Color: api.ClassificationColor(c.Color)}
}

func (h *Handlers) compliance(ctx context.Context, q store.Querier, ws pgtype.UUID) (api.Compliance, error) {
	out := api.Compliance{Classifications: []api.Classification{}, Attributes: []api.AttributeDef{}}
	row, err := q.GetCompliance(ctx, ws)
	if err != nil {
		return out, err
	}
	classes, err := q.ListClassifications(ctx, ws)
	if err != nil {
		return out, err
	}
	for _, c := range classes {
		out.Classifications = append(out.Classifications, classificationAPI(c))
		if c.ID == row.ClassificationID {
			out.DefaultClassification = &c.Name
		}
	}
	if row.RetentionDays.Valid {
		out.RetentionDays = ptr(int(row.RetentionDays.Int32))
	}
	attrs, err := q.ListWorkspaceAttributes(ctx, ws)
	for _, a := range attrs {
		out.Attributes = append(out.Attributes, api.AttributeDef{Key: a.Key, Name: a.Name})
	}
	return out, err
}

// GetCompliance implements api.ServerInterface.
func (h *Handlers) GetCompliance(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins see its compliance settings.") {
		return
	}
	out, err := h.compliance(r.Context(), h.Queries, pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "get compliance", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func cleanCompliance(in api.Compliance) string {
	if in.RetentionDays != nil && (*in.RetentionDays < 1 || *in.RetentionDays > 36500) {
		return "Retention is 1 to 36,500 days, or none."
	}
	if len(in.Classifications) > 10 || len(in.Attributes) > 20 {
		return "A workspace has up to 10 classifications and 20 attributes."
	}
	names := map[string]bool{}
	for _, c := range in.Classifications {
		name := strings.ToLower(strings.TrimSpace(c.Name))
		switch {
		case name == "" || utf8.RuneCountInString(c.Name) > 60 || utf8.RuneCountInString(c.Description) > 300:
			return "A classification has a name of 1 to 60 characters and a text of up to 300."
		case names[name]:
			return "Two classifications are called " + c.Name + "."
		}
		switch c.Color {
		case api.ClassificationColorNeutral, api.ClassificationColorInfo, api.ClassificationColorSuccess,
			api.ClassificationColorWarning, api.ClassificationColorDanger:
		default:
			return "A classification's color is neutral, info, success, warning or danger."
		}
		names[name] = true
	}
	if in.DefaultClassification != nil && !names[strings.ToLower(strings.TrimSpace(*in.DefaultClassification))] {
		return "The default classification is one of the list."
	}
	keys := map[string]bool{}
	for _, a := range in.Attributes {
		switch {
		case !fieldIDRE.MatchString(a.Key):
			return "An attribute's key has 1 to 32 lowercase letters, digits or _."
		case keys[a.Key]:
			return "Two attributes have the key " + a.Key + "."
		case strings.TrimSpace(a.Name) == "" || utf8.RuneCountInString(a.Name) > 60:
			return "An attribute's name has 1 to 60 characters."
		}
		keys[a.Key] = true
	}
	return ""
}

// SetCompliance implements api.ServerInterface.
func (h *Handlers) SetCompliance(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins change its compliance settings.") {
		return
	}
	var in api.Compliance
	if !decode(w, r, &in) {
		return
	}
	if problem := cleanCompliance(in); problem != "" {
		badRequest(w, r, problem)
		return
	}
	ws := pgUUID(workspaceID)
	var out api.Compliance
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		keep := []pgtype.UUID{}
		var def pgtype.UUID
		for i, c := range in.Classifications {
			id := pgtype.UUID{Bytes: guuid.Must(guuid.NewV7()), Valid: true}
			if c.Id != nil {
				id = pgUUID(*c.Id)
			}
			saved, err := q.ReplaceClassification(r.Context(), store.ReplaceClassificationParams{
				ID: id, WorkspaceID: ws, Name: strings.TrimSpace(c.Name), Description: strings.TrimSpace(c.Description),
				Color: string(c.Color), Position: int32(i), //nolint:gosec // at most 10
			})
			if err != nil {
				return err
			}
			keep = append(keep, saved.ID)
			if in.DefaultClassification != nil && strings.EqualFold(strings.TrimSpace(*in.DefaultClassification), saved.Name) {
				def = saved.ID
			}
		}
		if err := q.DeleteOtherClassifications(r.Context(), store.DeleteOtherClassificationsParams{WorkspaceID: ws, Keep: keep}); err != nil {
			return err
		}
		retention := pgtype.Int4{}
		if in.RetentionDays != nil {
			retention = pgtype.Int4{Int32: int32(*in.RetentionDays), Valid: true} //nolint:gosec // checked above
		}
		if err := q.SetWorkspaceCompliance(r.Context(), store.SetWorkspaceComplianceParams{ID: ws, RetentionDays: retention, ClassificationID: def}); err != nil {
			return err
		}
		if err := q.DeleteWorkspaceAttributes(r.Context(), ws); err != nil {
			return err
		}
		for _, a := range in.Attributes {
			if err := q.CreateWorkspaceAttribute(r.Context(), store.CreateWorkspaceAttributeParams{WorkspaceID: ws, Key: a.Key, Name: strings.TrimSpace(a.Name)}); err != nil {
				return err
			}
		}
		var err error
		out, err = h.compliance(r.Context(), q, ws)
		if err != nil {
			return err
		}
		return emit(r.Context(), q, events.WorkspaceUpdated, WorkspaceEvent{WorkspaceID: workspaceID.String()})
	})
	if isNoRows(err) { // a classification of another workspace
		badRequest(w, r, "No such classification in this workspace.")
		return
	}
	if err != nil {
		h.unavailable(w, r, "set compliance", err)
		return
	}
	h.record(r, ws, audit.ComplianceChanged, "workspace", workspaceID.String(), map[string]any{
		"retention_days": in.RetentionDays, "classifications": len(in.Classifications), "attributes": len(in.Attributes),
	})
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ListClassifications implements api.ServerInterface.
func (h *Handlers) ListClassifications(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	out, err := h.compliance(r.Context(), h.Queries, pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list classifications", err)
		return
	}
	var def *openapi_types.UUID
	for _, c := range out.Classifications {
		if out.DefaultClassification != nil && c.Name == *out.DefaultClassification {
			def = c.Id
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"classifications": out.Classifications, "default_id": def})
}

// ListMemberAttributes implements api.ServerInterface.
func (h *Handlers) ListMemberAttributes(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins see members' attributes.") {
		return
	}
	rows, err := h.Queries.ListMemberAttributes(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list attributes", err)
		return
	}
	type member struct {
		UserID     string            `json:"user_id"`
		Attributes map[string]string `json:"attributes"`
	}
	out := make([]member, len(rows))
	for i, row := range rows {
		out[i] = member{UserID: uuid(row.UserID).String(), Attributes: attributesOf(row.Attributes)}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"members": out})
}

// removeFromRuledChannels ends the memberships of a user in channels whose
// rules they no longer meet.
func (h *Handlers) removeFromRuledChannels(ctx context.Context, q *store.Queries, channels []store.Channel, user pgtype.UUID, attrs map[string]string) ([]store.Channel, error) {
	var removed []store.Channel
	for _, c := range channels {
		if meetsRules(accessRules(c), attrs) {
			continue
		}
		if _, err := q.RemoveMember(ctx, store.RemoveMemberParams{ChannelID: c.ID, UserID: user}); err != nil {
			return nil, err
		}
		removed = append(removed, c)
	}
	return removed, nil
}

// SetMemberAttributes implements api.ServerInterface.
func (h *Handlers) SetMemberAttributes(w http.ResponseWriter, r *http.Request, workspaceID, userID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins set members' attributes.") {
		return
	}
	var in api.Attributes
	if !decode(w, r, &in) {
		return
	}
	ws := pgUUID(workspaceID)
	defs, err := h.Queries.ListWorkspaceAttributes(r.Context(), ws)
	if err != nil {
		h.unavailable(w, r, "list attributes", err)
		return
	}
	attrs := map[string]string{}
	for k, v := range in {
		v = strings.TrimSpace(v)
		if !slices.ContainsFunc(defs, func(d store.WorkspaceAttribute) bool { return d.Key == k }) {
			badRequest(w, r, "The workspace has no attribute "+k+".")
			return
		}
		if utf8.RuneCountInString(v) > maxAttributeValueRn {
			badRequest(w, r, "An attribute's value has up to 100 characters.")
			return
		}
		if v != "" {
			attrs[k] = v
		}
	}
	if _, err := h.Queries.GetMemberAttributes(r.Context(), store.GetMemberAttributesParams{WorkspaceID: ws, UserID: pgUUID(userID)}); isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "Not a member of this workspace."})
		return
	}
	raw, _ := json.Marshal(attrs)
	var removed []store.Channel
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.SetMemberAttributes(r.Context(), store.SetMemberAttributesParams{WorkspaceID: ws, UserID: pgUUID(userID), Attributes: raw}); err != nil {
			return err
		}
		channels, err := q.ListRuledChannelsOfMember(r.Context(), store.ListRuledChannelsOfMemberParams{UserID: pgUUID(userID), WorkspaceID: ws})
		if err != nil {
			return err
		}
		removed, err = h.removeFromRuledChannels(r.Context(), q, channels, pgUUID(userID), attrs)
		return err
	})
	if err != nil {
		h.unavailable(w, r, "set attributes", err)
		return
	}
	for _, c := range removed {
		h.membersChanged(r.Context(), c, pgUUID(userID), events.ChannelLeft, toAPI(c, access{}))
	}
	h.record(r, ws, audit.MemberAttributesChanged, "user", userID.String(), map[string]any{"attributes": attrs, "removed_from": len(removed)})
	httpx.WriteJSON(w, http.StatusOK, api.Removed{Removed: len(removed)})
}

// SetChannelCompliance implements api.ServerInterface.
func (h *Handlers) SetChannelCompliance(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, ok := h.visibleChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if !role.admin() || isConversation(c) {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins set a channel's compliance.")
		return
	}
	var in api.ChannelCompliance
	if !decode(w, r, &in) {
		return
	}
	if in.RetentionDays != nil && (*in.RetentionDays < 1 || *in.RetentionDays > 36500) {
		badRequest(w, r, "Retention is 1 to 36,500 days, or the workspace's.")
		return
	}
	defs, err := h.Queries.ListWorkspaceAttributes(r.Context(), c.WorkspaceID)
	if err != nil {
		h.unavailable(w, r, "list attributes", err)
		return
	}
	if len(in.AccessRules) > 0 && (c.IsDefault || c.IsMandatory) {
		badRequest(w, r, "A channel for everyone has no access rules.")
		return
	}
	for i, rule := range in.AccessRules {
		if !slices.ContainsFunc(defs, func(d store.WorkspaceAttribute) bool { return d.Key == rule.Key }) {
			badRequest(w, r, "The workspace has no attribute "+rule.Key+".")
			return
		}
		values := []string{}
		for _, v := range rule.Values {
			if v = strings.TrimSpace(v); v != "" && utf8.RuneCountInString(v) <= maxAttributeValueRn {
				values = append(values, v)
			}
		}
		if len(values) == 0 || len(values) > 20 {
			badRequest(w, r, "A rule has 1 to 20 values.")
			return
		}
		in.AccessRules[i].Values = values
	}
	var class pgtype.UUID
	if in.ClassificationId != nil {
		cl, err := h.Queries.GetClassification(r.Context(), pgUUID(*in.ClassificationId))
		if isNoRows(err) || (err == nil && cl.WorkspaceID != c.WorkspaceID) {
			badRequest(w, r, "No such classification in this workspace.")
			return
		}
		if err != nil {
			h.unavailable(w, r, "get classification", err)
			return
		}
		class = cl.ID
	}
	retention := pgtype.Int4{}
	if in.RetentionDays != nil {
		retention = pgtype.Int4{Int32: int32(*in.RetentionDays), Valid: true} //nolint:gosec // checked above
	}
	raw, _ := json.Marshal(in.AccessRules)
	var removed []pgtype.UUID
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		if c, err = q.SetChannelCompliance(r.Context(), store.SetChannelComplianceParams{
			ID: c.ID, RetentionDays: retention, ClassificationID: class, AccessRules: raw,
		}); err != nil {
			return err
		}
		members, err := q.ListChannelMemberAttributes(r.Context(), c.ID)
		if err != nil {
			return err
		}
		for _, m := range members {
			if meetsRules(in.AccessRules, attributesOf(m.Attributes)) {
				continue
			}
			if _, err := q.RemoveMember(r.Context(), store.RemoveMemberParams{ChannelID: c.ID, UserID: m.UserID}); err != nil {
				return err
			}
			removed = append(removed, m.UserID)
		}
		return nil
	})
	if err != nil {
		h.unavailable(w, r, "set channel compliance", err)
		return
	}
	for _, u := range removed {
		h.membersChanged(r.Context(), c, u, events.ChannelLeft, toAPI(c, access{}))
	}
	h.publish(r.Context(), events.ChannelUpdated, ChannelEvent{Channel: toAPI(c, access{ch: RoleMember}), ChannelID: uuid(c.ID).String()})
	h.record(r, c.WorkspaceID, audit.ComplianceChanged, "channel", uuid(c.ID).String(), map[string]any{
		"channel": c.Name, "retention_days": in.RetentionDays, "access_rules": in.AccessRules, "removed": len(removed),
	})
	httpx.WriteJSON(w, http.StatusOK, api.Removed{Removed: len(removed)})
}

// --- legal holds ----------------------------------------------------------------

func tsOf(t *time.Time) pgtype.Timestamptz {
	if t == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: *t, Valid: true}
}

func timeOf(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	return &t.Time
}

func uuidsOf(ids []openapi_types.UUID) []pgtype.UUID {
	out := make([]pgtype.UUID, len(ids))
	for i, id := range ids {
		out[i] = pgUUID(id)
	}
	return out
}

func apiUUIDs(ids []pgtype.UUID) []openapi_types.UUID {
	out := make([]openapi_types.UUID, len(ids))
	for i, id := range ids {
		out[i] = uuid(id)
	}
	return out
}

func (h *Handlers) holdAPI(ctx context.Context, hold store.LegalHold) (api.LegalHold, error) {
	n, err := h.Queries.CountHeldMessages(ctx, store.CountHeldMessagesParams{
		WorkspaceID: hold.WorkspaceID, ChannelIds: hold.ChannelIds, UserIds: hold.UserIds,
		StartsAt: hold.StartsAt, EndsAt: hold.EndsAt,
	})
	if hold.ReleasedAt.Valid {
		n = 0
	}
	return api.LegalHold{
		Id: uuid(hold.ID), Name: hold.Name, Description: hold.Description,
		UserIds: apiUUIDs(hold.UserIds), ChannelIds: apiUUIDs(hold.ChannelIds),
		StartsAt: timeOf(hold.StartsAt), EndsAt: timeOf(hold.EndsAt), CreatedAt: hold.CreatedAt,
		ReleasedAt: timeOf(hold.ReleasedAt), MessageCount: int(n),
	}, err
}

func cleanHold(in api.LegalHoldInput) (string, string, string) {
	name := strings.TrimSpace(in.Name)
	desc := strings.TrimSpace(deref1(in.Description))
	switch {
	case name == "" || utf8.RuneCountInString(name) > 120 || utf8.RuneCountInString(desc) > 1000:
		return "", "", "A hold has a name of 1 to 120 characters and a description of up to 1,000."
	case len(in.UserIds)+len(in.ChannelIds) == 0:
		return "", "", "A hold keeps the messages of at least one person or channel."
	case len(in.UserIds) > 500 || len(in.ChannelIds) > 500:
		return "", "", "A hold covers up to 500 people and 500 channels."
	case in.StartsAt != nil && in.EndsAt != nil && !in.EndsAt.After(*in.StartsAt):
		return "", "", "A hold's period ends after it starts."
	}
	return name, desc, ""
}

// ListLegalHolds implements api.ServerInterface.
func (h *Handlers) ListLegalHolds(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceOwner(w, r, workspaceID, p.User, "Only the workspace's owners see legal holds.") {
		return
	}
	holds, err := h.Queries.ListLegalHolds(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list holds", err)
		return
	}
	out := make([]api.LegalHold, len(holds))
	for i, hold := range holds {
		if out[i], err = h.holdAPI(r.Context(), hold); err != nil {
			h.unavailable(w, r, "count held", err)
			return
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.LegalHold{"holds": out})
}

// CreateLegalHold implements api.ServerInterface.
func (h *Handlers) CreateLegalHold(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceOwner(w, r, workspaceID, p.User, "Only the workspace's owners place legal holds.") {
		return
	}
	var in api.LegalHoldInput
	if !decode(w, r, &in) {
		return
	}
	name, desc, problem := cleanHold(in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	hold, err := h.Queries.CreateLegalHold(r.Context(), store.CreateLegalHoldParams{
		WorkspaceID: pgUUID(workspaceID), Name: name, Description: desc,
		UserIds: uuidsOf(in.UserIds), ChannelIds: uuidsOf(in.ChannelIds),
		StartsAt: tsOf(in.StartsAt), EndsAt: tsOf(in.EndsAt), CreatedBy: p.User.ID,
	})
	if err != nil {
		h.unavailable(w, r, "create hold", err)
		return
	}
	h.record(r, hold.WorkspaceID, audit.LegalHoldChanged, "legal_hold", uuid(hold.ID).String(),
		map[string]any{"name": name, "change": "placed", "users": len(in.UserIds), "channels": len(in.ChannelIds)})
	out, err := h.holdAPI(r.Context(), hold)
	if err != nil {
		h.unavailable(w, r, "count held", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

func (h *Handlers) ownedHold(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.LegalHold, bool) {
	hold, err := h.Queries.GetLegalHold(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such legal hold."})
		return hold, false
	}
	if err != nil {
		h.unavailable(w, r, "get hold", err)
		return hold, false
	}
	return hold, h.requireWorkspaceOwner(w, r, uuid(hold.WorkspaceID), user, "Only the workspace's owners change legal holds.")
}

// UpdateLegalHold implements api.ServerInterface.
func (h *Handlers) UpdateLegalHold(w http.ResponseWriter, r *http.Request, holdID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	hold, ok := h.ownedHold(w, r, holdID, p.User)
	if !ok {
		return
	}
	var in api.LegalHoldInput
	if !decode(w, r, &in) {
		return
	}
	name, desc, problem := cleanHold(in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	hold, err := h.Queries.UpdateLegalHold(r.Context(), store.UpdateLegalHoldParams{
		ID: hold.ID, Name: name, Description: desc, UserIds: uuidsOf(in.UserIds), ChannelIds: uuidsOf(in.ChannelIds),
		StartsAt: tsOf(in.StartsAt), EndsAt: tsOf(in.EndsAt),
	})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "hold_released", Detail: "The hold was released."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "update hold", err)
		return
	}
	h.record(r, hold.WorkspaceID, audit.LegalHoldChanged, "legal_hold", uuid(hold.ID).String(),
		map[string]any{"name": name, "change": "updated", "users": len(in.UserIds), "channels": len(in.ChannelIds)})
	out, err := h.holdAPI(r.Context(), hold)
	if err != nil {
		h.unavailable(w, r, "count held", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ReleaseLegalHold implements api.ServerInterface.
func (h *Handlers) ReleaseLegalHold(w http.ResponseWriter, r *http.Request, holdID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	hold, ok := h.ownedHold(w, r, holdID, p.User)
	if !ok {
		return
	}
	released, err := h.Queries.ReleaseLegalHold(r.Context(), store.ReleaseLegalHoldParams{ID: hold.ID, UserID: p.User.ID})
	if isNoRows(err) { // released before
		released = hold
	} else if err != nil {
		h.unavailable(w, r, "release hold", err)
		return
	} else {
		h.record(r, hold.WorkspaceID, audit.LegalHoldChanged, "legal_hold", uuid(hold.ID).String(),
			map[string]any{"name": hold.Name, "change": "released"})
	}
	out, err := h.holdAPI(r.Context(), released)
	if err != nil {
		h.unavailable(w, r, "count held", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// --- eDiscovery export -------------------------------------------------------------

type exportLine struct {
	ID          string     `json:"id"`
	ChannelID   string     `json:"channel_id"`
	ChannelName string     `json:"channel_name"`
	AuthorID    string     `json:"author_id"`
	AuthorName  string     `json:"author_name"`
	Body        string     `json:"body"`
	RootID      string     `json:"root_id,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	EditedAt    *time.Time `json:"edited_at,omitempty"`
	DeletedAt   *time.Time `json:"deleted_at,omitempty"`
	HasFiles    bool       `json:"has_files"`
	Held        bool       `json:"held"`
	// Edits are the earlier versions, oldest first.
	Edits []exportEdit `json:"edits,omitempty"`
}

type exportEdit struct {
	Body       string    `json:"body"`
	WrittenAt  time.Time `json:"written_at"`
	ReplacedAt time.Time `json:"replaced_at"`
}

// ExportMessages implements api.ServerInterface.
func (h *Handlers) ExportMessages(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, params api.ExportMessagesParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceOwner(w, r, workspaceID, p.User, "Only the workspace's owners export messages.") {
		return
	}
	query := strings.TrimSpace(deref1(params.Q))
	if utf8.RuneCountInString(query) > 200 {
		badRequest(w, r, "The search has up to 200 characters.")
		return
	}
	arg := store.ExportMessagesParams{
		WorkspaceID: pgUUID(workspaceID), ChannelIds: uuidsOf(deref(params.ChannelIds)), UserIds: uuidsOf(deref(params.UserIds)),
		Since: tsOf(params.Since), Until: tsOf(params.Until), Query: query, RowLimit: exportPage,
	}
	h.record(r, arg.WorkspaceID, audit.MessagesExported, "workspace", workspaceID.String(), map[string]any{
		"since": params.Since, "until": params.Until, "channels": len(arg.ChannelIds), "users": len(arg.UserIds), "query": query,
	})
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", `attachment; filename="cenacle-export.ndjson"`)
	w.Header().Set("Cache-Control", "no-store")
	out := bufio.NewWriter(w)
	enc := json.NewEncoder(out)
	wrote := false
	for {
		rows, err := h.Queries.ExportMessages(r.Context(), arg)
		if err != nil {
			if !wrote {
				h.unavailable(w, r, "export messages", err)
			} else {
				h.Log.ErrorContext(r.Context(), "export messages", slog.Any("error", err))
			}
			return
		}
		var edited []pgtype.UUID
		for _, m := range rows {
			if m.EditedAt.Valid {
				edited = append(edited, m.ID)
			}
		}
		edits := map[pgtype.UUID][]exportEdit{}
		if len(edited) > 0 {
			list, err := h.Queries.ListEditsOfMessages(r.Context(), edited)
			if err != nil {
				if !wrote {
					h.unavailable(w, r, "export edits", err)
				} else {
					h.Log.ErrorContext(r.Context(), "export edits", slog.Any("error", err))
				}
				return
			}
			for _, e := range list {
				edits[e.MessageID] = append(edits[e.MessageID], exportEdit{Body: e.Body, WrittenAt: e.WrittenAt, ReplacedAt: e.ReplacedAt})
			}
		}
		for _, m := range rows {
			line := exportLine{
				ID: uuid(m.ID).String(), ChannelID: uuid(m.ChannelID).String(), ChannelName: m.ChannelName,
				AuthorID: uuid(m.AuthorID).String(), AuthorName: m.AuthorName, Body: m.Body, CreatedAt: m.CreatedAt,
				EditedAt: timeOf(m.EditedAt), DeletedAt: timeOf(m.DeletedAt), HasFiles: m.HasFiles, Held: m.Held,
				Edits: edits[m.ID],
			}
			if m.RootID.Valid {
				line.RootID = uuid(m.RootID).String()
			}
			if err := enc.Encode(line); err != nil {
				return
			}
			wrote = true
		}
		if len(rows) < exportPage {
			break
		}
		arg.After = rows[len(rows)-1].ID
		if err := out.Flush(); err != nil {
			return
		}
	}
	_ = out.Flush()
}

// --- retention ---------------------------------------------------------------------

// RetentionPurger deletes messages older than their retention.
type RetentionPurger struct {
	Queries *store.Queries
}

// Run deletes up to a batch of expired messages that no legal hold keeps.
func (p RetentionPurger) Run(ctx context.Context) (int, error) {
	n, err := p.Queries.PurgeExpiredMessages(ctx, retentionBatch)
	return int(n), err
}
