// SPDX-License-Identifier: AGPL-3.0-only

// Package policy holds the membership rules every path shares: who joins a
// workspace as a guest, who may enter a channel with access rules, and whom a
// guest may see. Handlers, the directory and the realtime layer ask here
// rather than deciding on their own.
package policy

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Guest is the workspace role of people who see only the channels they are
// added to and the people in them.
const Guest = "guest"

// IsGuest reports whether a person is a guest wherever they are: guests of the
// directory, people who came by a guest link and people of federated servers.
// The same rule is spelled out in SQL by AddAllUsersToWorkspace.
func IsGuest(u store.User) bool {
	return u.DirectoryRole.String == Guest || u.GuestLinkID.Valid || u.AuthService == "remote"
}

// JoinRole is the workspace role a person gets when joining with role: guests
// stay guests whatever the way in.
func JoinRole(u store.User, role string) string {
	if IsGuest(u) {
		return Guest
	}
	return role
}

// Rules are a channel's access rules (none: open to every member).
func Rules(c store.Channel) []api.AccessRule {
	out := []api.AccessRule{}
	_ = json.Unmarshal(c.AccessRules, &out)
	return out
}

// Attributes are a member's workspace attributes.
func Attributes(raw []byte) map[string]string {
	out := map[string]string{}
	_ = json.Unmarshal(raw, &out)
	return out
}

// Meets reports whether attributes meet rules: a member needs one of the
// values of every rule (case does not matter).
func Meets(rules []api.AccessRule, attrs map[string]string) bool {
	for _, rule := range rules {
		v := strings.ToLower(strings.TrimSpace(attrs[rule.Key]))
		if v == "" || !slices.ContainsFunc(rule.Values, func(x string) bool { return strings.ToLower(x) == v }) {
			return false
		}
	}
	return true
}

// AttributeSource is what Qualifies reads.
type AttributeSource interface {
	GetMemberAttributes(ctx context.Context, arg store.GetMemberAttributesParams) ([]byte, error)
}

// Qualifies reports whether a user may enter a channel by its access rules.
// Every path that makes someone a member of an existing channel asks it.
func Qualifies(ctx context.Context, q AttributeSource, c store.Channel, user pgtype.UUID) (bool, error) {
	rules := Rules(c)
	if len(rules) == 0 {
		return true, nil
	}
	raw, err := q.GetMemberAttributes(ctx, store.GetMemberAttributesParams{WorkspaceID: c.WorkspaceID, UserID: user})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	return Meets(rules, Attributes(raw)), nil
}

// PeopleSource is what VisiblePeople reads.
type PeopleSource interface {
	PeopleSharingChannels(ctx context.Context, arg store.PeopleSharingChannelsParams) ([]pgtype.UUID, error)
}

// VisiblePeople is whom a member with a workspace role may see in the
// workspace: nil (no limit) for everyone but guests, who see themselves and
// the people sharing a channel with them. Every read that discloses people
// (lists, profiles, presence, events, groups) filters by it.
func VisiblePeople(ctx context.Context, q PeopleSource, ws pgtype.UUID, user pgtype.UUID, role string) (map[pgtype.UUID]bool, error) {
	if role != Guest {
		return nil, nil
	}
	ids, err := q.PeopleSharingChannels(ctx, store.PeopleSharingChannelsParams{WorkspaceID: ws, UserID: user})
	if err != nil {
		return nil, err
	}
	out := map[pgtype.UUID]bool{user: true}
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}
