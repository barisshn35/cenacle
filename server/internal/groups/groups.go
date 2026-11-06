// SPDX-License-Identifier: AGPL-3.0-only

// Package groups applies what Cenacle ID's directory says about a person to
// the chat: their sign-in name, role (administrator, guest), and the
// workspaces and channels their directory groups give them. It runs at every
// sign-in and when the directory feed reports a change.
package groups

import (
	"context"
	"encoding/json"
	"strings"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/policy"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Profile is the directory part of a person's claims.
type Profile struct {
	Username string   // "" when the account has none
	Role     string   // "admin", "guest" or ""
	Groups   []string // directory group names
}

// Querier is what Apply needs (store.Queries in a transaction or not).
type Querier interface {
	store.Querier
}

func id(u pgtype.UUID) string { return guuid.UUID(u.Bytes).String() }

func emit(ctx context.Context, q Querier, typ string, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	return q.InsertOutboxEvent(ctx, store.InsertOutboxEventParams{Type: typ, Data: raw})
}

type channelRef struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
}

type membership struct {
	Channel     *channelRef `json:"channel,omitempty"`
	ChannelID   string      `json:"channel_id,omitempty"`
	WorkspaceID string      `json:"workspace_id,omitempty"`
	UserID      string      `json:"user_id,omitempty"`
}

// Apply brings a person's memberships in line with their directory profile.
// adminEmail is the configured instance administrator's address.
func Apply(ctx context.Context, q Querier, user store.User, p Profile, adminEmail string) error {
	var username, role pgtype.Text
	if p.Username != "" {
		username = pgtype.Text{String: p.Username, Valid: true}
	}
	if p.Role == "admin" || p.Role == "guest" {
		role = pgtype.Text{String: p.Role, Valid: true}
	}
	if username.Valid {
		// The directory's sign-in name is theirs: someone who chose it gets another.
		if err := q.ReleaseUsername(ctx, store.ReleaseUsernameParams{Username: username.String, ID: user.ID}); err != nil {
			return err
		}
	}
	if err := q.SetDirectoryProfile(ctx, store.SetDirectoryProfileParams{ID: user.ID, Username: username, DirectoryRole: role}); err != nil {
		return err
	}
	// Everyone has a @username (people outside a directory get one made up).
	if err := q.AssignUsername(ctx, user.ID); err != nil {
		return err
	}
	if err := q.ReplaceUserGroups(ctx, store.ReplaceUserGroupsParams{UserID: user.ID, Names: cleanGroups(p.Groups)}); err != nil {
		return err
	}
	guest := p.Role == "guest"
	uid := id(user.ID)
	changed, err := q.SetGuestRoles(ctx, store.SetGuestRolesParams{UserID: user.ID, Guest: guest})
	if err != nil {
		return err
	}
	for _, ws := range changed {
		// The person's open connections reload what they may hear there.
		if err := emit(ctx, q, events.WorkspaceJoined, membership{WorkspaceID: id(ws), UserID: uid}); err != nil {
			return err
		}
	}
	if guest {
		// A guest reviews no spillage.
		if err := q.DropSpillageReviewer(ctx, user.ID); err != nil {
			return err
		}
		left, err := q.LeaveDefaultChannelsAsGuest(ctx, user.ID)
		if err != nil {
			return err
		}
		for _, c := range left {
			if err := changedChannel(ctx, q, c, uid, events.ChannelLeft); err != nil {
				return err
			}
		}
	}

	// Everyone but guests is in the default workspace and its channels for everyone.
	if !guest {
		joined, err := q.JoinDefaultWorkspace(ctx, user.ID)
		if err != nil {
			return err
		}
		for _, ws := range joined {
			if err := joinedWorkspace(ctx, q, id(ws), uid); err != nil {
				return err
			}
		}
		channels, err := q.JoinDefaultChannels(ctx, store.JoinDefaultChannelsParams{UserID: user.ID})
		if err != nil {
			return err
		}
		for _, c := range channels {
			if err := emit(ctx, q, events.ChannelMembersChanged, membership{ChannelID: id(c)}); err != nil {
				return err
			}
		}
	}

	// Workspaces from groups.
	roles, err := q.WorkspaceRolesFromGroups(ctx, user.ID)
	if err != nil {
		return err
	}
	kept := make([]pgtype.UUID, 0, len(roles))
	for _, r := range roles {
		wsRole := r.Role
		if guest {
			wsRole = "guest"
		}
		joined, err := q.JoinWorkspaceViaGroup(ctx, store.JoinWorkspaceViaGroupParams{WorkspaceID: r.WorkspaceID, UserID: user.ID, Role: wsRole})
		if err != nil {
			return err
		}
		kept = append(kept, r.WorkspaceID)
		if joined {
			if err := joinedWorkspace(ctx, q, id(r.WorkspaceID), uid); err != nil {
				return err
			}
		}
	}
	gone, err := q.LeaveWorkspacesViaGroup(ctx, store.LeaveWorkspacesViaGroupParams{UserID: user.ID, Kept: kept})
	if err != nil {
		return err
	}
	for _, ws := range gone {
		if err := emit(ctx, q, events.WorkspaceLeft, membership{WorkspaceID: id(ws), UserID: uid}); err != nil {
			return err
		}
		if err := emit(ctx, q, events.WorkspaceMembersChanged, membership{WorkspaceID: id(ws)}); err != nil {
			return err
		}
	}

	// Channels from groups (in the workspaces the person is in now).
	fromGroups, err := q.ChannelsFromGroups(ctx, user.ID)
	if err != nil {
		return err
	}
	// A group does not lift a channel's access rules: who does not meet them
	// is neither added nor kept.
	channels := make([]pgtype.UUID, 0, len(fromGroups))
	for _, id := range fromGroups {
		c, err := q.GetChannel(ctx, id)
		if err != nil {
			return err
		}
		if ok, err := policy.Qualifies(ctx, q, c, user.ID); err != nil {
			return err
		} else if ok {
			channels = append(channels, id)
		}
	}
	for _, c := range channels {
		n, err := q.JoinChannelViaGroup(ctx, store.JoinChannelViaGroupParams{ChannelID: c, UserID: user.ID})
		if err != nil {
			return err
		}
		if n > 0 {
			if err := changedChannel(ctx, q, c, uid, events.ChannelJoined); err != nil {
				return err
			}
		}
	}
	left, err := q.LeaveChannelsViaGroup(ctx, store.LeaveChannelsViaGroupParams{UserID: user.ID, Kept: channels})
	if err != nil {
		return err
	}
	for _, c := range left {
		if err := changedChannel(ctx, q, c, uid, events.ChannelLeft); err != nil {
			return err
		}
	}

	// Instance administrators: the configured address, or the directory's role.
	byEmail := adminEmail != "" && user.EmailVerified && strings.EqualFold(user.Email, adminEmail)
	admin := p.Role == "admin" || byEmail
	if byEmail {
		// The configured address names one person: whoever had it before loses it.
		if err := q.RevokeEmailAdminsExcept(ctx, user.ID); err != nil {
			return err
		}
	}
	if admin != user.IsAdmin {
		if err := q.SetAdminByDirectory(ctx, store.SetAdminByDirectoryParams{ID: user.ID, IsAdmin: admin}); err != nil {
			return err
		}
	}
	if admin && !guest { // a guest owns nothing, whatever the configured address
		def, err := q.GetDefaultWorkspace(ctx)
		if err != nil {
			return err
		}
		if _, err := q.SetWorkspaceRole(ctx, store.SetWorkspaceRoleParams{WorkspaceID: def.ID, UserID: user.ID, Role: "owner"}); err != nil {
			return err
		}
	}
	return nil
}

func joinedWorkspace(ctx context.Context, q Querier, ws, user string) error {
	if err := emit(ctx, q, events.WorkspaceJoined, membership{WorkspaceID: ws, UserID: user}); err != nil {
		return err
	}
	return emit(ctx, q, events.WorkspaceMembersChanged, membership{WorkspaceID: ws})
}

func changedChannel(ctx context.Context, q Querier, channel pgtype.UUID, user, typ string) error {
	c, err := q.GetChannel(ctx, channel)
	if err != nil {
		return err
	}
	ref := &channelRef{ID: id(c.ID), WorkspaceID: id(c.WorkspaceID)}
	if err := emit(ctx, q, typ, membership{Channel: ref, UserID: user}); err != nil {
		return err
	}
	return emit(ctx, q, events.ChannelMembersChanged, membership{ChannelID: id(c.ID)})
}

// cleanGroups keeps sensible group names (the claim comes from Cenacle ID).
func cleanGroups(names []string) []string {
	out := make([]string, 0, len(names))
	seen := map[string]bool{}
	for _, n := range names {
		n = strings.TrimSpace(n)
		if n == "" || len(n) > 200 || seen[strings.ToLower(n)] {
			continue
		}
		seen[strings.ToLower(n)] = true
		out = append(out, n)
		if len(out) == 500 {
			break
		}
	}
	return out
}
