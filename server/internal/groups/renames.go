// SPDX-License-Identifier: AGPL-3.0-only

package groups

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// A rename is a change of the name Cenacle ID gives a group (ADR 0046): a
// provider's groups took its name as a prefix in 0.99.2, and renaming a
// provider renames its groups. Ambiguous: several groups had the old name, so
// a mapping of it may mean any of them.
type rename struct {
	ID        string `json:"id"`
	Old       string `json:"old"`
	New       string `json:"new"`
	Ambiguous bool   `json:"ambiguous"`
}

type renamePage struct {
	Renames []rename `json:"renames"`
	Next    string   `json:"next"`
	More    bool     `json:"more"`
}

// errNoRenames: Cenacle ID is older than the group-renames feed.
var errNoRenames = errors.New("cenacle id has no group-renames feed")

// FollowRenames moves the workspace and channel group mappings along with the
// group name changes at Cenacle ID that the chat has not applied yet. A
// mapping of an ambiguous name is not moved: it is marked for review with the
// new names as candidates. Renames never create a mapping, nor raise a role:
// where the new name is mapped already, that mapping stays. Every change is
// in the audit log of its workspace.
func (f *Feed) FollowRenames(ctx context.Context) error {
	cursor, err := f.Queries.LockGroupRenameCursor(ctx)
	if err != nil {
		return err
	}
	for range 100 { // at most 50 000 changes a round
		page, err := f.fetchRenames(ctx, cursor)
		if errors.Is(err, errNoRenames) {
			f.Log.DebugContext(ctx, "group renames", "error", err)
			return nil
		}
		if err != nil {
			return err
		}
		if len(page.Renames) == 0 {
			return nil
		}
		if cursor, err = f.applyRenames(ctx, page.Renames); err != nil {
			return err
		}
		if !page.More {
			return nil
		}
	}
	return nil
}

func (f *Feed) fetchRenames(ctx context.Context, after int64) (renamePage, error) {
	u := strings.TrimSuffix(f.Issuer, "/") + "/directory/v1/group-renames?after=" + strconv.FormatInt(after, 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return renamePage{}, err
	}
	req.SetBasicAuth(url.QueryEscape(f.ClientID), url.QueryEscape(f.ClientSecret))
	res, err := f.HTTP.Do(req)
	if err != nil {
		return renamePage{}, err
	}
	defer func() { _ = res.Body.Close() }()
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return renamePage{}, errNoRenames
	default:
		return renamePage{}, fmt.Errorf("group renames: status %d (is directory_feed set for the client?)", res.StatusCode)
	}
	var page renamePage
	if err := json.NewDecoder(io.LimitReader(res.Body, 16<<20)).Decode(&page); err != nil {
		return renamePage{}, fmt.Errorf("group renames: %w", err)
	}
	return page, nil
}

// applyRenames applies a page of changes in one transaction and returns the
// new cursor. Changes another caller applied meanwhile are skipped.
func (f *Feed) applyRenames(ctx context.Context, renames []rename) (int64, error) {
	var cursor int64
	err := inTx(ctx, f.DB, func(q *store.Queries) error {
		var err error
		if cursor, err = q.LockGroupRenameCursor(ctx); err != nil {
			return err
		}
		start := cursor
		for i := 0; i < len(renames); {
			r := renames[i]
			id, err := strconv.ParseInt(r.ID, 10, 64)
			if err != nil {
				return fmt.Errorf("group renames: id %q", r.ID)
			}
			// The changes of one ambiguous name come together: one review.
			candidates := []string{r.New}
			j := i + 1
			for ; r.Ambiguous && j < len(renames) && renames[j].Ambiguous && strings.EqualFold(renames[j].Old, r.Old); j++ {
				candidates = append(candidates, renames[j].New)
				if id, err = strconv.ParseInt(renames[j].ID, 10, 64); err != nil {
					return fmt.Errorf("group renames: id %q", renames[j].ID)
				}
			}
			i = j
			if id <= start {
				continue
			}
			cursor = id
			if !valid(r.Old) || !valid(r.New) {
				continue
			}
			if r.Ambiguous {
				err = flag(ctx, q, r.Old, candidates)
			} else {
				err = follow(ctx, q, r.Old, r.New)
			}
			if err != nil {
				return err
			}
		}
		return q.SaveGroupRenameCursor(ctx, cursor)
	})
	return cursor, err
}

func valid(name string) bool {
	return strings.TrimSpace(name) != "" && len([]rune(name)) <= 200
}

// follow moves the mappings (and the groups people are in) of old to its new name.
func follow(ctx context.Context, q *store.Queries, old, to string) error {
	if strings.EqualFold(old, to) {
		return nil // mappings match whatever the case
	}
	names := store.RenameWorkspaceGroupMappingsParams{OldName: old, NewName: to}
	moved, err := q.RenameWorkspaceGroupMappings(ctx, names)
	if err != nil {
		return err
	}
	for _, m := range moved {
		if err := record(ctx, q, m.WorkspaceID, audit.GroupMappingRenamed, "group", old,
			map[string]any{"to": to, "role": m.Role}); err != nil {
			return err
		}
	}
	dropped, err := q.DropRenamedWorkspaceGroupMappings(ctx, store.DropRenamedWorkspaceGroupMappingsParams{OldName: old, NewName: to})
	if err != nil {
		return err
	}
	for _, m := range dropped {
		if err := record(ctx, q, m.WorkspaceID, audit.GroupMappingMerged, "group", m.GroupName,
			map[string]any{"to": to, "role": m.Role, "kept_role": m.KeptRole}); err != nil {
			return err
		}
	}
	movedChannels, err := q.RenameChannelGroupMappings(ctx, store.RenameChannelGroupMappingsParams(names))
	if err != nil {
		return err
	}
	for _, m := range movedChannels {
		if err := record(ctx, q, m.WorkspaceID, audit.ChannelGroupRenamed, "channel", id(m.ChannelID),
			map[string]any{"from": old, "to": to}); err != nil {
			return err
		}
	}
	droppedChannels, err := q.DropRenamedChannelGroupMappings(ctx, store.DropRenamedChannelGroupMappingsParams{OldName: old, NewName: to})
	if err != nil {
		return err
	}
	for _, m := range droppedChannels {
		if err := record(ctx, q, m.WorkspaceID, audit.ChannelGroupMerged, "channel", id(m.ChannelID),
			map[string]any{"from": m.GroupName, "to": to}); err != nil {
			return err
		}
	}
	// People keep their memberships until Cenacle ID sends them again.
	if err := q.RenameUserGroups(ctx, store.RenameUserGroupsParams(names)); err != nil {
		return err
	}
	return q.DropRenamedUserGroups(ctx, store.DropRenamedUserGroupsParams{OldName: old, NewName: to})
}

// flag marks the mappings of an ambiguous name for review.
func flag(ctx context.Context, q *store.Queries, old string, candidates []string) error {
	ws, err := q.FlagWorkspaceGroupMappings(ctx, store.FlagWorkspaceGroupMappingsParams{OldName: old, Candidates: candidates})
	if err != nil {
		return err
	}
	for _, m := range ws {
		if err := record(ctx, q, m.WorkspaceID, audit.GroupMappingNeedsReview, "group", m.GroupName,
			map[string]any{"candidates": m.ReviewCandidates}); err != nil {
			return err
		}
	}
	channels, err := q.FlagChannelGroupMappings(ctx, store.FlagChannelGroupMappingsParams{OldName: old, Candidates: candidates})
	if err != nil {
		return err
	}
	for _, m := range channels {
		if err := record(ctx, q, m.WorkspaceID, audit.ChannelGroupNeedsReview, "channel", id(m.ChannelID),
			map[string]any{"group": m.GroupName, "candidates": m.ReviewCandidates}); err != nil {
			return err
		}
	}
	return nil
}

// record writes an audit event of Cenacle ID's (no actor) with the change.
func record(ctx context.Context, q *store.Queries, workspace pgtype.UUID, action, targetType, targetID string, detail map[string]any) error {
	detail["by"] = "cenacle_id"
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	return q.InsertAuditEvent(ctx, store.InsertAuditEventParams{
		WorkspaceID: workspace, Action: action, TargetType: targetType, TargetID: targetID, Detail: raw,
	})
}
