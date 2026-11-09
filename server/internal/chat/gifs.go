// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"image/gif"
	"io"
	"net/http"
	"strings"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// A person's own GIFs: how many and how large.
const (
	MaxUserGIFs    = 40
	MaxUserGIFSize = 8 << 20
	maxGIFSide     = 4096
)

// Problem codes of a person's GIFs.
const (
	CodeGIFLimit = "gif_limit"
	CodeNotGIF   = "not_a_gif"
)

// SaveSticker implements api.ServerInterface.
func (h *Handlers) SaveSticker(w http.ResponseWriter, r *http.Request, stickerID openapi_types.UUID) {
	h.setStickerSaved(w, r, stickerID, true)
}

// UnsaveSticker implements api.ServerInterface.
func (h *Handlers) UnsaveSticker(w http.ResponseWriter, r *http.Request, stickerID openapi_types.UUID) {
	h.setStickerSaved(w, r, stickerID, false)
}

// setStickerSaved saves a sticker of a workspace the person is in (guests
// too: it only orders their picker), or takes it out of their saved ones.
func (h *Handlers) setStickerSaved(w http.ResponseWriter, r *http.Request, stickerID openapi_types.UUID, saved bool) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	s, err := h.Queries.GetSticker(r.Context(), pgUUID(stickerID))
	if isNoRows(err) || (err == nil && saved && s.RemovedAt.Valid) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such sticker."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get sticker", err)
		return
	}
	if _, ok := h.workspaceRole(w, r, uuid(s.WorkspaceID), p.User); !ok {
		return
	}
	if saved {
		err = h.Queries.SaveSticker(r.Context(), store.SaveStickerParams{UserID: p.User.ID, StickerID: s.ID})
	} else {
		err = h.Queries.UnsaveSticker(r.Context(), store.UnsaveStickerParams{UserID: p.User.ID, StickerID: s.ID})
	}
	if err != nil {
		h.unavailable(w, r, "save sticker", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func userGIFAPI(g store.ListUserGIFsRow) api.UserGif {
	id := uuid(g.ID)
	return api.UserGif{Id: id, Name: g.Name, Width: int(g.Width), Height: int(g.Height), Size: int(g.Size),
		Url: "/api/gifs/" + id.String(), CreatedAt: g.CreatedAt}
}

// ListMyGifs implements api.ServerInterface.
func (h *Handlers) ListMyGifs(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListUserGIFs(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list gifs", err)
		return
	}
	out := make([]api.UserGif, 0, len(rows))
	for _, g := range rows {
		out = append(out, userGIFAPI(g))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.UserGif{"gifs": out})
}

// AddGif implements api.ServerInterface.
func (h *Handlers) AddGif(w http.ResponseWriter, r *http.Request, params api.AddGifParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	name := strings.Join(strings.Fields(params.Name), " ")
	if name == "" || len([]rune(name)) > 60 {
		badRequest(w, r, "Name the GIF (up to 60 characters).")
		return
	}
	ctx := r.Context()
	n, err := h.Queries.CountUserGIFs(ctx, p.User.ID)
	if err != nil {
		h.unavailable(w, r, "count gifs", err)
		return
	}
	if n >= MaxUserGIFs {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeGIFLimit, Detail: "You have 40 GIFs; remove one first."})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxUserGIFSize))
	if err != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusRequestEntityTooLarge, Code: httpx.CodeBadRequest, Detail: "GIFs may be up to 8 MB."})
		return
	}
	// Only the header is read: the GIF is shown by browsers, never decoded here.
	cfg, err := gif.DecodeConfig(bytes.NewReader(data))
	if err != nil || !bytes.HasPrefix(data, []byte("GIF8")) ||
		cfg.Width < 1 || cfg.Height < 1 || cfg.Width > maxGIFSide || cfg.Height > maxGIFSide {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusUnprocessableEntity, Code: CodeNotGIF, Detail: "Use a GIF of at most 4096 pixels a side."})
		return
	}
	g, err := h.Queries.InsertUserGIF(ctx, store.InsertUserGIFParams{
		UserID: p.User.ID, Name: name, Width: int32(cfg.Width), Height: int32(cfg.Height), Data: data,
	})
	if err != nil {
		h.unavailable(w, r, "insert gif", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, userGIFAPI(store.ListUserGIFsRow(g)))
}

// DeleteGif implements api.ServerInterface.
func (h *Handlers) DeleteGif(w http.ResponseWriter, r *http.Request, gifID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	n, err := h.Queries.DeleteUserGIF(r.Context(), store.DeleteUserGIFParams{ID: pgUUID(gifID), UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "delete gif", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetGif implements api.ServerInterface.
func (h *Handlers) GetGif(w http.ResponseWriter, r *http.Request, gifID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	g, err := h.Queries.GetUserGIF(r.Context(), pgUUID(gifID))
	if err != nil || g.UserID != p.User.ID {
		if err == nil || isNoRows(err) {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound})
			return
		}
		h.unavailable(w, r, "get gif", err)
		return
	}
	hdr := w.Header()
	hdr.Set("Content-Type", "image/gif")
	hdr.Set("X-Content-Type-Options", "nosniff")
	hdr.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	hdr.Set("Cache-Control", "private, max-age=31536000, immutable")
	_, _ = w.Write(g.Data)
}
