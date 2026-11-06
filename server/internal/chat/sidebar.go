// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Built-in sidebar sections, named by key (categories and the person's own
// sections are named by their id).
const (
	SectionFavorites = "favorites"
	SectionChannels  = "channels"
	SectionDirect    = "direct"
	SectionUnreads   = "unreads"
)

// MaxSidebarSections is how many sections of their own a person can have.
const MaxSidebarSections = 30

// SidebarEvent is the data of sidebar.changed: the person's arrangement of a
// workspace's sidebar changed (on another device).
type SidebarEvent struct {
	UserID      string `json:"user_id"`
	WorkspaceID string `json:"workspace_id"`
}

func emptySidebar() api.SidebarLayout {
	return api.SidebarLayout{
		Order: []string{}, Sections: []api.SidebarSection{}, Placements: map[string]string{},
		Collapsed: []string{},
	}
}

// GetSidebar implements api.ServerInterface.
func (h *Handlers) GetSidebar(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	raw, err := h.Queries.GetSidebarLayout(r.Context(), store.GetSidebarLayoutParams{
		UserID: p.User.ID, WorkspaceID: pgUUID(workspaceID),
	})
	out := emptySidebar()
	if err != nil && !isNoRows(err) {
		h.unavailable(w, r, "get sidebar", err)
		return
	}
	if err == nil {
		_ = json.Unmarshal(raw, &out)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// SetSidebar implements api.ServerInterface.
func (h *Handlers) SetSidebar(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SidebarLayout
	if !decode(w, r, &in) {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	ctx := r.Context()
	ws := pgUUID(workspaceID)
	channels, err := h.Queries.ListWorkspaceMemberChannels(ctx, store.ListWorkspaceMemberChannelsParams{
		UserID: p.User.ID, WorkspaceID: ws,
	})
	if err != nil {
		h.unavailable(w, r, "list channels", err)
		return
	}
	categories, err := h.Queries.ListCategoryIDs(ctx, ws)
	if err != nil {
		h.unavailable(w, r, "list categories", err)
		return
	}
	out, problem := normalizeSidebar(in, ids(channels), ids(categories))
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	raw, err := json.Marshal(out)
	if err != nil {
		h.unavailable(w, r, "encode sidebar", err)
		return
	}
	if err := h.Queries.PutSidebarLayout(ctx, store.PutSidebarLayoutParams{
		UserID: p.User.ID, WorkspaceID: ws, Layout: raw,
	}); err != nil {
		h.unavailable(w, r, "save sidebar", err)
		return
	}
	h.publish(ctx, events.SidebarChanged, SidebarEvent{
		UserID: uuid(p.User.ID).String(), WorkspaceID: workspaceID.String(),
	})
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ids is the set of the text of ids.
func ids(list []pgtype.UUID) map[string]bool {
	set := make(map[string]bool, len(list))
	for _, id := range list {
		set[uuid(id).String()] = true
	}
	return set
}

// normalizeSidebar checks an arrangement and keeps only what still exists:
// placements of channels the person is in, into sections that exist; known
// sections in the order and among the folded ones, each once.
func normalizeSidebar(in api.SidebarLayout, channels, categories map[string]bool) (api.SidebarLayout, string) {
	out := emptySidebar()
	out.GroupUnreads = in.GroupUnreads
	if len(in.Sections) > MaxSidebarSections {
		return out, "Up to 30 sections of your own."
	}
	sections := map[string]bool{}
	names := map[string]bool{}
	for _, s := range in.Sections {
		name := strings.Join(strings.Fields(s.Name), " ")
		if name == "" || utf8.RuneCountInString(name) > 40 {
			return out, "A section's name has 1 to 40 characters."
		}
		id := s.Id.String()
		if sections[id] {
			return out, "Each section needs its own id."
		}
		if names[strings.ToLower(name)] {
			return out, "Two sections cannot have the same name."
		}
		sections[id], names[strings.ToLower(name)] = true, true
		out.Sections = append(out.Sections, api.SidebarSection{Id: s.Id, Name: name})
	}
	known := func(key string) bool {
		switch key {
		case SectionFavorites, SectionChannels, SectionDirect, SectionUnreads:
			return true
		}
		return sections[key] || categories[key]
	}
	for channel, section := range in.Placements {
		if _, err := guuid.Parse(channel); err != nil || !channels[strings.ToLower(channel)] {
			continue
		}
		if section == SectionFavorites || sections[section] {
			out.Placements[strings.ToLower(channel)] = section
		}
	}
	keep := func(list []string) []string {
		kept := []string{}
		for _, key := range list {
			if known(key) && !slices.Contains(kept, key) {
				kept = append(kept, key)
			}
		}
		return kept
	}
	out.Order, out.Collapsed = keep(in.Order), keep(in.Collapsed)
	return out, ""
}
