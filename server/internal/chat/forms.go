// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Limits of forms.
const (
	MaxForms        = 200
	CodeFormLimit   = "form_limit"
	CodeInvalidForm = "invalid_answers"
)

var fieldIDRE = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

// cleanFields checks a form's fields as sent.
func cleanFields(in []api.FormField) ([]api.FormField, string) {
	if len(in) == 0 || len(in) > 30 {
		return nil, "A form has 1 to 30 fields."
	}
	seen := map[string]bool{}
	out := make([]api.FormField, len(in))
	for i, f := range in {
		f.Label = strings.TrimSpace(f.Label)
		switch {
		case !fieldIDRE.MatchString(f.Id):
			return nil, "A field's id has 1 to 32 lowercase letters, digits or _."
		case seen[f.Id]:
			return nil, "Two fields have the id " + f.Id + "."
		case f.Label == "" || utf8.RuneCountInString(f.Label) > 200:
			return nil, "A field's label has 1 to 200 characters."
		}
		seen[f.Id] = true
		switch f.Kind {
		case api.FormFieldKindText, api.FormFieldKindTextarea, api.FormFieldKindNumber, api.FormFieldKindDate,
			api.FormFieldKindCheckbox, api.FormFieldKindPerson:
			f.Options = nil
		case api.FormFieldKindSelect, api.FormFieldKindMultiselect:
			if f.Options == nil || len(*f.Options) < 2 || len(*f.Options) > 50 {
				return nil, "A choice field has 2 to 50 options."
			}
			opts := make([]string, 0, len(*f.Options))
			for _, o := range *f.Options {
				o = strings.TrimSpace(o)
				if o == "" || utf8.RuneCountInString(o) > 100 || slices.Contains(opts, o) {
					return nil, "Options have 1 to 100 characters and differ from each other."
				}
				opts = append(opts, o)
			}
			f.Options = &opts
		default:
			return nil, "Unknown field kind."
		}
		if f.Help != nil {
			h := strings.TrimSpace(*f.Help)
			if utf8.RuneCountInString(h) > 300 {
				return nil, "A field's help is longer than 300 characters."
			}
			f.Help = &h
		}
		out[i] = f
	}
	return out, ""
}

func formAPI(f store.Form) api.Form {
	out := api.Form{Id: uuid(f.ID), Name: f.Name, Description: f.Description, UpdatedAt: f.UpdatedAt, Fields: []api.FormField{}}
	_ = json.Unmarshal(f.Fields, &out.Fields)
	return out
}

// formAnswer is one answer of a submission, as shown.
type formAnswer struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

// answers checks the values given for a form's fields and returns them as
// shown, and as workflow variables (form.<id>).
func answers(ctx context.Context, q store.Querier, workspace pgtype.UUID, fields []api.FormField, values api.FormValues) ([]formAnswer, map[string]string, string) {
	out := make([]formAnswer, 0, len(fields))
	vars := map[string]string{}
	for _, f := range fields {
		raw, given := values[f.Id]
		var text string
		var list []string
		if given {
			if s, err := raw.AsFormValues0(); err == nil {
				text = strings.TrimSpace(s)
			} else if l, err := raw.AsFormValues1(); err == nil {
				list = l
			}
		}
		empty := text == "" && len(list) == 0
		if empty {
			if f.Required {
				return nil, nil, "“" + f.Label + "” is required."
			}
			out = append(out, formAnswer{ID: f.Id, Label: f.Label, Kind: string(f.Kind)})
			vars[f.Id] = ""
			continue
		}
		shown, varValue := text, text
		switch f.Kind {
		case api.FormFieldKindText:
			if strings.ContainsRune(text, '\n') || utf8.RuneCountInString(text) > 300 {
				return nil, nil, "“" + f.Label + "” takes one line of up to 300 characters."
			}
		case api.FormFieldKindTextarea:
			if utf8.RuneCountInString(text) > 4000 {
				return nil, nil, "“" + f.Label + "” is longer than 4000 characters."
			}
		case api.FormFieldKindNumber:
			if _, err := strconv.ParseFloat(text, 64); err != nil {
				return nil, nil, "“" + f.Label + "” is a number."
			}
		case api.FormFieldKindDate:
			if _, err := time.Parse(time.DateOnly, text); err != nil {
				return nil, nil, "“" + f.Label + "” is a date (YYYY-MM-DD)."
			}
		case api.FormFieldKindCheckbox:
			if text != "true" && text != "false" {
				return nil, nil, "“" + f.Label + "” is true or false."
			}
			if text == "false" && f.Required {
				return nil, nil, "“" + f.Label + "” must be checked."
			}
			shown = map[string]string{"true": "✓", "false": "—"}[text]
		case api.FormFieldKindSelect:
			if !slices.Contains(deref(f.Options), text) {
				return nil, nil, "Choose one of the options of “" + f.Label + "”."
			}
		case api.FormFieldKindMultiselect:
			if text != "" {
				list = []string{text}
			}
			for _, v := range list {
				if !slices.Contains(deref(f.Options), v) {
					return nil, nil, "Choose among the options of “" + f.Label + "”."
				}
			}
			shown = strings.Join(list, ", ")
			varValue = shown
		case api.FormFieldKindPerson:
			parsed, err := guuid.Parse(text)
			if err != nil {
				return nil, nil, "“" + f.Label + "” is a person of the workspace."
			}
			id := pgUUID(parsed)
			member, err := q.GetWorkspaceMemberName(ctx, store.GetWorkspaceMemberNameParams{WorkspaceID: workspace, UserID: id})
			if err != nil {
				return nil, nil, "“" + f.Label + "” is a person of the workspace."
			}
			shown = member
			varValue = "<@" + uuid(id).String() + ">"
		}
		out = append(out, formAnswer{ID: f.Id, Label: f.Label, Kind: string(f.Kind), Value: shown})
		vars[f.Id] = varValue
	}
	return out, vars, ""
}

func deref[T any](p *[]T) []T {
	if p == nil {
		return nil
	}
	return *p
}

func submissionAPI(s store.FormSubmission, userName string) api.Submission {
	out := api.Submission{Id: uuid(s.ID), FormName: s.FormName, CreatedAt: s.CreatedAt, Answers: []api.FormAnswer{}}
	if s.FormID.Valid {
		out.FormId = ptr(uuid(s.FormID))
	}
	if s.UserID.Valid {
		out.User = &api.Author{Id: uuid(s.UserID), DisplayName: userName}
	}
	_ = json.Unmarshal(s.Answers, &out.Answers)
	return out
}

// ListForms implements api.ServerInterface.
func (h *Handlers) ListForms(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	rows, err := h.Queries.ListForms(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list forms", err)
		return
	}
	out := make([]api.Form, len(rows))
	for i, f := range rows {
		out[i] = formAPI(f)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.Form{"forms": out})
}

func formInput(in api.FormInput) (name, description string, fields []byte, problem string) {
	name = strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 120 {
		return "", "", nil, "A form's name has 1 to 120 characters."
	}
	if in.Description != nil {
		description = strings.TrimSpace(*in.Description)
	}
	if utf8.RuneCountInString(description) > 1000 {
		return "", "", nil, "A form's description is longer than 1000 characters."
	}
	clean, problem := cleanFields(in.Fields)
	if problem != "" {
		return "", "", nil, problem
	}
	fields, _ = json.Marshal(clean)
	return name, description, fields, ""
}

// CreateForm implements api.ServerInterface.
func (h *Handlers) CreateForm(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.FormInput
	if !decode(w, r, &in) || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins write forms.") {
		return
	}
	name, description, fields, problem := formInput(in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	n, err := h.Queries.CountForms(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "count forms", err)
		return
	}
	if n >= MaxForms {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeFormLimit, Detail: "A workspace has up to 200 forms."})
		return
	}
	f, err := h.Queries.CreateForm(r.Context(), store.CreateFormParams{
		WorkspaceID: pgUUID(workspaceID), Name: name, Description: description, Fields: fields, CreatedBy: p.User.ID,
	})
	if err != nil {
		h.unavailable(w, r, "create form", err)
		return
	}
	h.record(r, f.WorkspaceID, audit.FormChanged, "form", uuid(f.ID).String(), map[string]any{"name": name, "change": "created"})
	httpx.WriteJSON(w, http.StatusCreated, formAPI(f))
}

// adminForm loads a form of a workspace the user administers.
func (h *Handlers) adminForm(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Form, bool) {
	f, err := h.Queries.GetForm(r.Context(), pgUUID(id))
	if isNoRows(err) || (err == nil && f.ArchivedAt.Valid) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such form."})
		return f, false
	}
	if err != nil {
		h.unavailable(w, r, "get form", err)
		return f, false
	}
	return f, h.requireWorkspaceAdmin(w, r, uuid(f.WorkspaceID), user, "Only the workspace's owners and admins change forms.")
}

// UpdateForm implements api.ServerInterface.
func (h *Handlers) UpdateForm(w http.ResponseWriter, r *http.Request, formID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.FormInput
	if !decode(w, r, &in) {
		return
	}
	f, ok := h.adminForm(w, r, formID, p.User)
	if !ok {
		return
	}
	name, description, fields, problem := formInput(in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	f, err := h.Queries.UpdateForm(r.Context(), store.UpdateFormParams{ID: f.ID, Name: name, Description: description, Fields: fields})
	if err != nil {
		h.unavailable(w, r, "update form", err)
		return
	}
	h.record(r, f.WorkspaceID, audit.FormChanged, "form", uuid(f.ID).String(), map[string]any{"name": name, "change": "updated"})
	httpx.WriteJSON(w, http.StatusOK, formAPI(f))
}

// ArchiveForm implements api.ServerInterface.
func (h *Handlers) ArchiveForm(w http.ResponseWriter, r *http.Request, formID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	f, ok := h.adminForm(w, r, formID, p.User)
	if !ok {
		return
	}
	if err := h.Queries.ArchiveForm(r.Context(), f.ID); err != nil {
		h.unavailable(w, r, "archive form", err)
		return
	}
	h.record(r, f.WorkspaceID, audit.FormChanged, "form", uuid(f.ID).String(), map[string]any{"name": f.Name, "change": "archived"})
	w.WriteHeader(http.StatusNoContent)
}

// ListFormSubmissions implements api.ServerInterface.
func (h *Handlers) ListFormSubmissions(w http.ResponseWriter, r *http.Request, formID openapi_types.UUID, params api.ListFormSubmissionsParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	f, err := h.Queries.GetForm(r.Context(), pgUUID(formID))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such form."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get form", err)
		return
	}
	if !h.requireWorkspaceAdmin(w, r, uuid(f.WorkspaceID), p.User, "Only the workspace's owners and admins read all submissions.") {
		return
	}
	arg := store.ListFormSubmissionsParams{FormID: f.ID, RowLimit: 51}
	if params.Before != nil {
		arg.Before = pgUUID(*params.Before)
	}
	rows, err := h.Queries.ListFormSubmissions(r.Context(), arg)
	if err != nil {
		h.unavailable(w, r, "list submissions", err)
		return
	}
	more := len(rows) > 50
	if more {
		rows = rows[:50]
	}
	out := make([]api.Submission, len(rows))
	for i, s := range rows {
		out[i] = submissionAPI(store.FormSubmission{ID: s.ID, FormID: s.FormID, WorkspaceID: s.WorkspaceID, UserID: s.UserID,
			FormName: s.FormName, Answers: s.Answers, CreatedAt: s.CreatedAt}, s.UserName)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"submissions": out, "has_more": more})
}

// SubmitForm implements api.ServerInterface.
func (h *Handlers) SubmitForm(w http.ResponseWriter, r *http.Request, formID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SubmitFormJSONBody
	if !decode(w, r, &in) {
		return
	}
	f, err := h.Queries.GetForm(r.Context(), pgUUID(formID))
	if isNoRows(err) || (err == nil && f.ArchivedAt.Valid) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such form."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get form", err)
		return
	}
	c, role, ok := h.memberChannel(w, r, in.ChannelId, p.User)
	if !ok {
		return
	}
	if c.WorkspaceID != f.WorkspaceID || !canPost(c, role) {
		forbidden(w, r, httpx.CodeForbidden, "Fill in forms in channels of their workspace you can post in.")
		return
	}
	if !serverReadable(w, r, c) { // the answers are kept as the server reads them
		return
	}
	if h.timedOut(w, r, c.WorkspaceID, p.User) || !h.allowMessage(w, r, p.User) {
		return
	}
	var fields []api.FormField
	_ = json.Unmarshal(f.Fields, &fields)
	shown, _, problem := answers(r.Context(), h.Queries, f.WorkspaceID, fields, in.Values)
	if problem != "" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: CodeInvalidForm, Detail: problem})
		return
	}
	raw, _ := json.Marshal(shown)
	var out api.Message
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		s, err := q.CreateSubmission(r.Context(), store.CreateSubmissionParams{
			FormID: f.ID, WorkspaceID: f.WorkspaceID, UserID: p.User.ID, FormName: f.Name, Answers: raw,
		})
		if err != nil {
			return err
		}
		out, err = postMessageTo(r.Context(), q, c, p.User, "", "form-"+uuid(s.ID).String(), []byte("[]"), replyTo{},
			postExtras{submission: s.ID})
		return err
	})
	if err != nil {
		h.unavailable(w, r, "submit form", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

// automationMessages fills in the task cards and form submissions of messages.
func automationMessages(ctx context.Context, q store.Querier, msgs []api.Message) error {
	var tasks, subs []pgtype.UUID
	for _, m := range msgs {
		if m.Task != nil {
			tasks = append(tasks, pgUUID(m.Task.Id))
		}
		if m.Submission != nil {
			subs = append(subs, pgUUID(m.Submission.Id))
		}
	}
	if len(subs) > 0 {
		rows, err := q.ListSubmissionsByID(ctx, subs)
		if err != nil {
			return err
		}
		byID := map[openapi_types.UUID]api.Submission{}
		for _, s := range rows {
			byID[uuid(s.ID)] = submissionAPI(store.FormSubmission{ID: s.ID, FormID: s.FormID, WorkspaceID: s.WorkspaceID,
				UserID: s.UserID, FormName: s.FormName, Answers: s.Answers, CreatedAt: s.CreatedAt}, s.UserName)
		}
		for i, m := range msgs {
			if m.Submission != nil {
				if s, ok := byID[m.Submission.Id]; ok {
					msgs[i].Submission = &s
				} else {
					msgs[i].Submission = nil
				}
			}
		}
	}
	if len(tasks) > 0 {
		rows, err := q.ListWorkflowTasksByID(ctx, tasks)
		if err != nil {
			return err
		}
		byID := map[openapi_types.UUID]api.Task{}
		for _, t := range rows {
			byID[uuid(t.ID)] = taskAPI(store.WorkflowTask{ID: t.ID, RunID: t.RunID, WorkspaceID: t.WorkspaceID, Kind: t.Kind,
				Title: t.Title, Assignees: t.Assignees, FormID: t.FormID, Status: t.Status, DoneBy: t.DoneBy, DoneAt: t.DoneAt,
				Comment: t.Comment, SubmissionID: t.SubmissionID, CreatedAt: t.CreatedAt}, t.DoneByName)
		}
		for i, m := range msgs {
			if m.Task != nil {
				if t, ok := byID[m.Task.Id]; ok {
					msgs[i].Task = &t
				} else {
					msgs[i].Task = nil
				}
			}
		}
	}
	return nil
}
