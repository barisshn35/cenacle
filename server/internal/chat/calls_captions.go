// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"regexp"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Live captions (ADR 0052).
const (
	// MaxCaptionAudio is how much one utterance may weigh.
	MaxCaptionAudio = 512 << 10
	// captionTimeout bounds one transcription: a late caption is no caption.
	captionTimeout = 20 * time.Second
	// captionWorkers is how many transcriptions run at once; more are dropped.
	captionWorkers = 4
	// captionsPerSecond is how many utterances one person may send a second.
	captionsPerSecond = 3
)

var (
	captionSlots = make(chan struct{}, captionWorkers)
	// noise the model writes for silence or sounds ("[BLANK_AUDIO]", "(music)").
	captionNoise = regexp.MustCompile(`^\s*[\[(][^\])]*[\])]\s*$`)
)

func (h *Handlers) captionsAvailable() bool {
	return h.Calls != nil && h.Calls.Config != nil && h.Calls.Config.CaptionsURL != ""
}

// SetCallCaptions implements api.ServerInterface.
func (h *Handlers) SetCallCaptions(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetCallCaptionsJSONBody
	if !decode(w, r, &in) {
		return
	}
	call, ok := h.accessibleCall(w, r, id, p)
	if !ok {
		return
	}
	if in.On {
		allowed, err := h.Queries.CallCaptionsAllowed(r.Context(), call.ID)
		if err != nil {
			h.callError(w, r, err)
			return
		}
		if !allowed.CallsCaptions || !h.captionsAvailable() {
			forbidden(w, r, "captions_unavailable", "Live captions are not allowed in this workspace.")
			return
		}
	}
	inCall, err := h.Queries.InCall(r.Context(), store.InCallParams{CallID: call.ID, UserID: p.User.ID})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	if !inCall || call.EndedAt.Valid {
		notInCall(w, r)
		return
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		changed, e := q.SetCallCaptions(r.Context(), store.SetCallCaptionsParams{CaptionsOn: in.On, UserID: p.User.ID, ID: call.ID})
		if e != nil {
			return e
		}
		return emitCall(r.Context(), q, changed, events.CallParticipants)
	})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	if c, err := h.Queries.GetChannel(r.Context(), call.ChannelID); err == nil {
		h.record(r, c.WorkspaceID, "call.captions_changed", "call", uuid(call.ID).String(), map[string]any{"on": in.On})
	}
	w.WriteHeader(http.StatusNoContent)
}

// CallCaptionEvent is the data of call.caption.
type CallCaptionEvent struct {
	CallID    string    `json:"call_id"`
	ChannelID string    `json:"channel_id"`
	UserID    string    `json:"user_id"`
	Text      string    `json:"text"`
	At        time.Time `json:"at"`
}

// SendCaptionAudio implements api.ServerInterface.
func (h *Handlers) SendCaptionAudio(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, params api.SendCaptionAudioParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	kind := strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])
	if kind != "audio/webm" && kind != "audio/ogg" {
		badRequest(w, r, "Send WebM or Ogg Opus audio.")
		return
	}
	call, ok := h.accessibleCall(w, r, id, p)
	if !ok {
		return
	}
	inCall, err := h.Queries.InCall(r.Context(), store.InCallParams{CallID: call.ID, UserID: p.User.ID})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	if !call.CaptionsOn || call.EndedAt.Valid || !inCall || !h.captionsAvailable() {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "captions_off",
			Detail: "Captions are off in this call, or you are not in it."})
		return
	}
	user := uuid(p.User.ID).String()
	n, _, err := h.Limiter.Hit(r.Context(), "cenacle:captions:"+uuid(call.ID).String()+":"+user, time.Second)
	if err != nil {
		h.unavailable(w, r, "captions rate limit", err)
		return
	}
	if n > captionsPerSecond {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusTooManyRequests, Code: httpx.CodeRateLimited,
			Detail: "Too much audio at once."})
		return
	}
	audio, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxCaptionAudio))
	if err != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusRequestEntityTooLarge, Code: httpx.CodeBadRequest,
			Detail: "An utterance may be up to 512 KiB."})
		return
	}
	select {
	case captionSlots <- struct{}{}:
	default:
		// Behind: this caption is skipped; the call goes on.
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusServiceUnavailable, Code: "captions_busy",
			Detail: "Captions are falling behind; this part is skipped."})
		return
	}
	language := "auto"
	if params.Language != nil {
		language = string(*params.Language)
	}
	// The answer does not wait for the text: it arrives as an event.
	w.WriteHeader(http.StatusNoContent)
	go func() {
		defer func() { <-captionSlots }()
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), captionTimeout)
		defer cancel()
		text, err := h.transcribe(ctx, audio, kind, language)
		if err != nil {
			h.Log.WarnContext(ctx, "caption", "error", err)
			return
		}
		if text == "" {
			return
		}
		// Kept only while the call's notes are on (the query checks it).
		if err := h.Queries.AddCallNote(ctx, store.AddCallNoteParams{CallID: call.ID, UserID: p.User.ID, Text: truncateRunes(text, 2000)}); err != nil {
			h.Log.WarnContext(ctx, "call note", "error", err)
		}
		if h.Ephemeral == nil {
			return
		}
		if err := h.Ephemeral.Publish(ctx, events.CallCaption, CallCaptionEvent{
			CallID: uuid(call.ID).String(), ChannelID: uuid(call.ChannelID).String(), UserID: user, Text: text, At: time.Now().UTC(),
		}); err != nil {
			h.Log.WarnContext(ctx, "publish caption", "error", err)
		}
	}()
}

// captionClient talks to the speech to text service on the internal network.
var captionClient = &http.Client{Timeout: captionTimeout}

// transcribe sends an utterance to whisper.cpp's server (/inference) and
// returns its text, without what the model writes for silence.
func (h *Handlers) transcribe(ctx context.Context, audio []byte, kind, language string) (string, error) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	name := "audio.webm"
	if kind == "audio/ogg" {
		name = "audio.ogg"
	}
	part, err := form.CreateFormFile("file", name)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(audio); err != nil {
		return "", err
	}
	for k, v := range map[string]string{"response_format": "json", "temperature": "0", "no_timestamps": "true", "language": language} {
		if err := form.WriteField(k, v); err != nil {
			return "", err
		}
	}
	if err := form.Close(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.Calls.Config.CaptionsURL+"/inference", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	res, err := captionClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return "", &httpStatusError{res.StatusCode}
	}
	var out struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&out); err != nil {
		return "", err
	}
	text := strings.Join(strings.Fields(out.Text), " ")
	if captionNoise.MatchString(text) {
		return "", nil
	}
	return text, nil
}

type httpStatusError struct{ status int }

func (e *httpStatusError) Error() string { return "captions service: " + http.StatusText(e.status) }

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
