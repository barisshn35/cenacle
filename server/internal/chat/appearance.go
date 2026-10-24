// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
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

// Fonts people upload.
const (
	MaxUserFonts    = 5
	MaxUserFontSize = 2 << 20
	CodeFontLimit   = "font_limit"
	CodeNotFont     = "not_a_font"
)

// EditableUITexts are the interface texts administrators may replace (keys of
// the web app's translations).
var EditableUITexts = []string{
	"auth.title", "auth.subtitle", "auth.continue", "auth.help",
	"shell.channelStart", "shell.composerPlaceholder",
}

// fontID is a library font ("inter") or one of the user's ("user:<uuid>").
var fontID = regexp.MustCompile(`^([a-z0-9-]{2,40}|user:[0-9a-f-]{36})$`)

// DefaultAppearance is what people see until they choose.
func DefaultAppearance() api.Appearance {
	var a api.Appearance
	a.Theme = api.System
	a.Preset = api.AppearancePresetWorkspace
	a.Density = api.AppearanceDensityAuto
	a.Fonts.Template = api.AppearanceFontsTemplateWorkspace
	a.Fonts.Text, a.Fonts.Code = "inter", "jetbrains-mono"
	a.FontSize = 14
	a.LineHeight = api.AppearanceLineHeightNormal
	a.Code.Theme = api.AppearanceCodeThemeGithub
	a.Code.LineNumbers, a.Code.Wrap, a.Code.Ligatures = false, false, true
	return a
}

func validAppearance(a api.Appearance) bool {
	return a.Theme.Valid() && a.Preset.Valid() && a.Density.Valid() && a.Fonts.Template.Valid() &&
		fontID.MatchString(a.Fonts.Text) && fontID.MatchString(a.Fonts.Code) &&
		a.FontSize >= 12 && a.FontSize <= 20 && a.LineHeight.Valid() && a.Code.Theme.Valid()
}

// readAppearance merges what is stored over the defaults (settings added in a
// later version keep their default; anything unreadable is ignored).
func readAppearance(raw []byte) api.Appearance {
	a := DefaultAppearance()
	stored := a
	if json.Unmarshal(raw, &stored) == nil && validAppearance(stored) {
		return stored
	}
	return a
}

// GetMyAppearance implements api.ServerInterface.
func (h *Handlers) GetMyAppearance(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	raw, err := h.Queries.GetAppearance(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "get appearance", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, readAppearance(raw))
}

// SetMyAppearance implements api.ServerInterface.
func (h *Handlers) SetMyAppearance(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.Appearance
	if !decode(w, r, &in) {
		return
	}
	if !validAppearance(in) {
		badRequest(w, r, "Some appearance settings are not known values.")
		return
	}
	raw, _ := json.Marshal(in)
	if err := h.Queries.SetAppearance(r.Context(), store.SetAppearanceParams{UserID: p.User.ID, Appearance: raw}); err != nil {
		h.unavailable(w, r, "set appearance", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, in)
}

// workspaceAppearance reads a workspace's defaults (Modern, Geist, in Cenacle's
// own colors unless its admins chose; v0.29).
func workspaceAppearance(raw []byte) api.WorkspaceAppearance {
	a := api.WorkspaceAppearance{Preset: api.ThemePresetCenacle, FontTemplate: api.FontTemplateModern}
	stored := a
	if json.Unmarshal(raw, &stored) == nil && stored.Preset.Valid() && stored.FontTemplate.Valid() {
		return stored
	}
	return a
}

// SetWorkspaceAppearance implements api.ServerInterface.
func (h *Handlers) SetWorkspaceAppearance(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.WorkspaceAppearance
	if !decode(w, r, &in) {
		return
	}
	ws, role, ok := h.administeredWorkspace(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	if !in.Preset.Valid() || !in.FontTemplate.Valid() {
		badRequest(w, r, "Choose a known theme preset and font template.")
		return
	}
	raw, _ := json.Marshal(in)
	if err := h.Queries.SetWorkspaceAppearance(r.Context(), store.SetWorkspaceAppearanceParams{ID: ws.ID, Appearance: raw}); err != nil {
		h.unavailable(w, r, "set workspace appearance", err)
		return
	}
	ws.Appearance = raw
	h.publish(r.Context(), events.WorkspaceUpdated, WorkspaceEvent{WorkspaceID: uuid(ws.ID).String()})
	httpx.WriteJSON(w, http.StatusOK, workspaceAPI(ws, role))
}

// fontFormat recognises a font file by its first bytes.
func fontFormat(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte("wOF2")):
		return "woff2"
	case bytes.HasPrefix(data, []byte("wOFF")):
		return "woff"
	case bytes.HasPrefix(data, []byte{0, 1, 0, 0}), bytes.HasPrefix(data, []byte("true")):
		return "truetype"
	case bytes.HasPrefix(data, []byte("OTTO")):
		return "opentype"
	}
	return ""
}

var fontContentType = map[string]string{
	"woff2": "font/woff2", "woff": "font/woff", "truetype": "font/ttf", "opentype": "font/otf",
}

func userFontAPI(id pgtype.UUID, name, format string, size int32, created pgtype.Timestamptz) api.UserFont {
	return api.UserFont{Id: uuid(id), Name: name, Format: api.UserFontFormat(format), Size: int(size), CreatedAt: created.Time}
}

// ListMyFonts implements api.ServerInterface.
func (h *Handlers) ListMyFonts(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListUserFonts(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list fonts", err)
		return
	}
	out := make([]api.UserFont, 0, len(rows))
	for _, f := range rows {
		out = append(out, userFontAPI(f.ID, f.Name, f.Format, f.Size, pgtype.Timestamptz{Time: f.CreatedAt, Valid: true}))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"fonts": out})
}

// UploadFont implements api.ServerInterface.
func (h *Handlers) UploadFont(w http.ResponseWriter, r *http.Request, params api.UploadFontParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	name := strings.Join(strings.Fields(params.Name), " ")
	if name == "" || len([]rune(name)) > 60 {
		badRequest(w, r, "Name the font (up to 60 characters).")
		return
	}
	ctx := r.Context()
	n, err := h.Queries.CountUserFonts(ctx, p.User.ID)
	if err != nil {
		h.unavailable(w, r, "count fonts", err)
		return
	}
	if n >= MaxUserFonts {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeFontLimit,
			Detail: "You have five fonts; remove one first."})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxUserFontSize))
	if err != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusRequestEntityTooLarge, Code: httpx.CodeBadRequest,
			Detail: "Fonts may be up to 2 MB."})
		return
	}
	format := fontFormat(data)
	if format == "" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusUnprocessableEntity, Code: CodeNotFont,
			Detail: "Use a WOFF2, WOFF, TrueType or OpenType font."})
		return
	}
	f, err := h.Queries.InsertUserFont(ctx, store.InsertUserFontParams{UserID: p.User.ID, Name: name, Format: format, Data: data})
	if err != nil {
		h.unavailable(w, r, "insert font", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, userFontAPI(f.ID, f.Name, f.Format, f.Size, pgtype.Timestamptz{Time: f.CreatedAt, Valid: true}))
}

// DeleteFont implements api.ServerInterface.
func (h *Handlers) DeleteFont(w http.ResponseWriter, r *http.Request, fontID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	n, err := h.Queries.DeleteUserFont(r.Context(), store.DeleteUserFontParams{ID: pgUUID(fontID), UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "delete font", err)
		return
	}
	if n == 0 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetFont implements api.ServerInterface.
func (h *Handlers) GetFont(w http.ResponseWriter, r *http.Request, fontID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	f, err := h.Queries.GetUserFont(r.Context(), pgUUID(fontID))
	if err != nil || f.UserID != p.User.ID {
		if err == nil || isNoRows(err) {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound})
			return
		}
		h.unavailable(w, r, "get font", err)
		return
	}
	hdr := w.Header()
	hdr.Set("Content-Type", fontContentType[f.Format])
	hdr.Set("X-Content-Type-Options", "nosniff")
	hdr.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	hdr.Set("Cache-Control", "private, max-age=31536000, immutable")
	_, _ = w.Write(f.Data)
}

func (h *Handlers) uiTexts(r *http.Request) (api.UITexts, error) {
	rows, err := h.Queries.ListUITexts(r.Context())
	if err != nil {
		return api.UITexts{}, err
	}
	texts := map[string]map[string]string{}
	for _, row := range rows {
		if texts[row.Locale] == nil {
			texts[row.Locale] = map[string]string{}
		}
		texts[row.Locale][row.Key] = row.Value
	}
	return api.UITexts{Texts: texts, Editable: EditableUITexts}, nil
}

// GetUITexts implements api.ServerInterface. It needs no session.
func (h *Handlers) GetUITexts(w http.ResponseWriter, r *http.Request) {
	out, err := h.uiTexts(r)
	if err != nil {
		h.unavailable(w, r, "ui texts", err)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	httpx.WriteJSON(w, http.StatusOK, out)
}

// SetUITexts implements api.ServerInterface.
func (h *Handlers) SetUITexts(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if !requireInstanceAdmin(w, r, p) {
		return
	}
	var in api.SetUITextsJSONBody
	if !decode(w, r, &in) {
		return
	}
	if !in.Locale.Valid() {
		badRequest(w, r, "Texts are for en or tr.")
		return
	}
	editable := map[string]bool{}
	for _, k := range EditableUITexts {
		editable[k] = true
	}
	for k, v := range in.Texts {
		if !editable[k] || len([]rune(v)) > 500 {
			badRequest(w, r, "Only the editable texts can be replaced, with up to 500 characters each.")
			return
		}
	}
	ctx := r.Context()
	err := inTx(ctx, h.DB, func(q *store.Queries) error {
		if err := q.DeleteUITexts(ctx, string(in.Locale)); err != nil {
			return err
		}
		for k, v := range in.Texts {
			if v = strings.TrimSpace(v); v != "" {
				if err := q.InsertUIText(ctx, store.InsertUITextParams{Key: k, Locale: string(in.Locale), Value: v}); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		h.unavailable(w, r, "set ui texts", err)
		return
	}
	h.record(r, pgtype.UUID{}, audit.UITextsChanged, "instance", "", map[string]any{"locale": in.Locale})
	h.GetUITexts(w, r)
}
