// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Limits and codes of moderation.
const (
	MaxSlowMode        = 21600
	MaxForumTags       = 20
	MaxMessageTags     = 5
	MaxAutomodRules    = 20
	MaxTimeout         = 28 * 24 * time.Hour
	CodeSlowMode       = "slow_mode"
	CodeTimedOut       = "timed_out"
	CodeAutomodBlocked = "automod_blocked"
	CodeAutomodLimit   = "automod_limit"
)

func ptr[T any](v T) *T { return &v }

// cleanTags trims, deduplicates (regardless of case) and checks tags.
func cleanTags(in []string, limit int) ([]string, string) {
	out := []string{}
	for _, t := range in {
		t = strings.TrimSpace(t)
		if t == "" || utf8.RuneCountInString(t) > 40 || strings.ContainsFunc(t, unicode.IsControl) {
			return nil, "A tag has 1 to 40 characters."
		}
		if !slices.ContainsFunc(out, func(o string) bool { return strings.EqualFold(o, t) }) {
			out = append(out, t)
		}
	}
	if len(out) > limit {
		return nil, fmt.Sprintf("At most %d tags.", limit)
	}
	return out, ""
}

// requireWorkspaceAdmin answers 403 unless the user owns or administers the workspace.
func (h *Handlers) requireWorkspaceAdmin(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User, detail string) bool {
	role, ok := h.workspaceRole(w, r, id, user)
	if !ok {
		return false
	}
	if !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, detail)
		return false
	}
	return true
}

// timedOut answers 403 when the user is timed out in the workspace.
func (h *Handlers) timedOut(w http.ResponseWriter, r *http.Request, workspace pgtype.UUID, user store.User) bool {
	return h.refused(w, r, "get timeout")(memberTimeout(r.Context(), h.Queries, workspace, user))
}

// slowedDown answers 429 when slow mode makes the member wait (managers are exempt).
func (h *Handlers) slowedDown(w http.ResponseWriter, r *http.Request, c store.Channel, role access, user store.User) bool {
	return h.refused(w, r, "slow mode")(slowMode(r.Context(), h.Queries, c, role, user))
}

// refused answers a posting rule's refusal or failure and says whether there was one.
func (h *Handlers) refused(w http.ResponseWriter, r *http.Request, what string) func(*postRefusal, error) bool {
	return func(no *postRefusal, err error) bool {
		if err != nil {
			h.unavailable(w, r, what, err)
			return true
		}
		if no != nil {
			no.write(w, r)
			return true
		}
		return false
	}
}

// ---------------------------------------------------------------- AutoMod ---

type automodConfig struct {
	Words          []string `json:"words,omitempty"`
	MaxMentions    int      `json:"max_mentions,omitempty"`
	AllowedDomains []string `json:"allowed_domains,omitempty"`
}

// fold lowers text and removes accents (Turkish dotted and dotless i too)
// and compatibility forms (full-width letters).
func fold(s string) string {
	s = strings.NewReplacer("İ", "i", "I", "i", "ı", "i").Replace(s)
	t := transform.Chain(norm.NFKD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
	out, _, err := transform.String(t, s)
	if err != nil {
		out = s
	}
	return strings.ToLower(out)
}

// automodText is a message's text as the client shows it, for AutoMod:
// character references decoded, invisible format characters (zero-width
// spaces, soft hyphens) and markdown's backslash escapes removed.
func automodText(s string) string {
	s = html.UnescapeString(s)
	s = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
	return escapeRE.ReplaceAllString(s, "$1")
}

var (
	// wordRE: words; markdown's emphasis (_word_, __word__) is no part of them.
	wordRE = regexp.MustCompile(`[\p{L}\p{N}]+`)
	// escapeRE: a backslash escape of ASCII punctuation (markdown shows the character).
	escapeRE = regexp.MustCompile("\\\\([!-/:-@\\[-`{-~])")
	// linkRE finds the hosts of what the client shows as links: http(s)
	// addresses (in text, autolinks and destinations; browsers also take
	// backslashes or no slashes), GFM's www. autolinks and scheme-relative
	// destinations ([x](//host), [x]: //host).
	linkRE = regexp.MustCompile(`(?i)https?:[/\\]*([^/\\\s?#<>()\[\]"'` + "`" + `]+)` +
		`|(?:^|[\s*_~(])(www\.[^/\\\s?#<>()\[\]"'` + "`" + `]+)` +
		`|(?:\]\(\s*<?|^\s*\[[^\]]*\]:\s*<?)//([^/\\\s?#<>()\[\]"'` + "`" + `]+)`)
)

// words splits folded text into its words.
func words(s string) []string { return wordRE.FindAllString(fold(s), -1) }

// hasWords reports whether text has the keyword's words in a row (a
// trailing * matches any word starting with the last one).
func hasWords(text []string, keyword string) bool {
	keyword = strings.TrimSpace(keyword)
	prefix := strings.HasSuffix(keyword, "*")
	k := words(strings.TrimSuffix(keyword, "*"))
	if len(k) == 0 {
		return false
	}
	for i := 0; i+len(k) <= len(text); i++ {
		match := true
		for j, w := range k {
			t := text[i+j]
			if t != w && (!prefix || j != len(k)-1 || !strings.HasPrefix(t, w)) {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// linkHost is a link's host as a browser reads it: no user part, no port,
// percent escapes decoded, lower case, without the punctuation that ends a
// sentence after it.
func linkHost(h string) string {
	if i := strings.LastIndex(h, "@"); i >= 0 {
		h = h[i+1:]
	}
	if i := strings.Index(h, ":"); i >= 0 {
		h = h[:i]
	}
	if u, err := url.PathUnescape(h); err == nil {
		h = u
	}
	return strings.ToLower(strings.TrimRight(h, ".,;:!*_~'\""))
}

// automodMatch reports whether a rule matches a message body, read as the
// client shows it (see automodText).
func automodMatch(rule store.AutomodRule, body string) bool {
	var cfg automodConfig
	_ = json.Unmarshal(rule.Config, &cfg)
	body = automodText(body)
	switch rule.Kind {
	case "keywords":
		text := words(body)
		for _, k := range cfg.Words {
			if hasWords(text, k) {
				return true
			}
		}
	case "mentions":
		// <@id> and @name alike (an @name may also be a group: counted all the same).
		return cfg.MaxMentions > 0 && len(mentionedIDs(body))+len(groupHandles(body)) > cfg.MaxMentions
	case "links":
		for _, line := range strings.Split(body, "\n") {
			for _, m := range linkRE.FindAllStringSubmatch(line, -1) {
				host := linkHost(m[1] + m[2] + m[3])
				if host == "" {
					continue
				}
				allowed := false
				for _, d := range cfg.AllowedDomains {
					d = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(d), "."))
					if host == d || strings.HasSuffix(host, "."+d) {
						allowed = true
						break
					}
				}
				if !allowed {
					return true
				}
			}
		}
	}
	return false
}

// automod checks a message against the workspace's rules (automodRules):
// a blocking rule answers 400; flagging rules are returned to be reported
// once it is sent.
func (h *Handlers) automod(w http.ResponseWriter, r *http.Request, c store.Channel, role access, body string) ([]string, bool) {
	flags, no, err := automodRules(r.Context(), h.Queries, c, role, body)
	if h.refused(w, r, "automod")(no, err) {
		return nil, false
	}
	return flags, true
}

func automodAPI(rule store.AutomodRule) api.AutomodRule {
	var cfg automodConfig
	_ = json.Unmarshal(rule.Config, &cfg)
	out := api.AutomodRule{
		Id: uuid(rule.ID), Name: rule.Name, Kind: api.AutomodRuleKind(rule.Kind), Action: api.AutomodRuleAction(rule.Action),
		Words: append([]string{}, cfg.Words...), MaxMentions: cfg.MaxMentions,
		AllowedDomains: append([]string{}, cfg.AllowedDomains...), Enabled: rule.Enabled,
		ExemptRoles: make([]api.AutomodRuleExemptRoles, len(rule.ExemptRoles)),
	}
	for i, role := range rule.ExemptRoles {
		out.ExemptRoles[i] = api.AutomodRuleExemptRoles(role)
	}
	return out
}

// automodInput validates a rule as sent.
func automodInput(in api.AutomodRuleInput) (store.CreateAutomodRuleParams, string) {
	out := store.CreateAutomodRuleParams{Name: strings.TrimSpace(in.Name), Kind: string(in.Kind),
		Action: string(in.Action), Enabled: in.Enabled == nil || *in.Enabled,
		ExemptRoles: []string{WorkspaceOwner, WorkspaceAdmin}}
	if out.Name == "" || utf8.RuneCountInString(out.Name) > 80 {
		return out, "A rule's name has 1 to 80 characters."
	}
	if out.Action != "block" && out.Action != "flag" {
		return out, "action must be block or flag."
	}
	if in.ExemptRoles != nil {
		out.ExemptRoles = []string{}
		for _, role := range *in.ExemptRoles {
			out.ExemptRoles = append(out.ExemptRoles, string(role))
		}
	}
	var cfg automodConfig
	switch out.Kind {
	case "keywords":
		if in.Words != nil {
			for _, w := range *in.Words {
				if w = strings.TrimSpace(w); w != "" {
					cfg.Words = append(cfg.Words, w)
				}
			}
		}
		if len(cfg.Words) == 0 || len(cfg.Words) > 200 {
			return out, "A keywords rule needs 1 to 200 words."
		}
	case "mentions":
		if in.MaxMentions == nil || *in.MaxMentions < 1 || *in.MaxMentions > 100 {
			return out, "A mentions rule needs max_mentions between 1 and 100."
		}
		cfg.MaxMentions = *in.MaxMentions
	case "links":
		if in.AllowedDomains != nil {
			for _, d := range *in.AllowedDomains {
				if d = strings.ToLower(strings.TrimSpace(d)); d != "" {
					cfg.AllowedDomains = append(cfg.AllowedDomains, d)
				}
			}
		}
		if len(cfg.AllowedDomains) > 100 {
			return out, "At most 100 allowed domains."
		}
	default:
		return out, "kind must be keywords, mentions or links."
	}
	out.Config, _ = json.Marshal(cfg)
	return out, ""
}

// ListAutomodRules implements api.ServerInterface.
func (h *Handlers) ListAutomodRules(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins see its AutoMod rules.") {
		return
	}
	rules, err := h.Queries.ListAutomodRules(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list automod rules", err)
		return
	}
	out := make([]api.AutomodRule, len(rules))
	for i, rule := range rules {
		out[i] = automodAPI(rule)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.AutomodRule{"rules": out})
}

// CreateAutomodRule implements api.ServerInterface.
func (h *Handlers) CreateAutomodRule(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.AutomodRuleInput
	if !decode(w, r, &in) {
		return
	}
	if !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins change its AutoMod rules.") {
		return
	}
	arg, problem := automodInput(in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	n, err := h.Queries.CountAutomodRules(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "count automod rules", err)
		return
	}
	if n >= MaxAutomodRules {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeAutomodLimit,
			Detail: "A workspace has up to 20 AutoMod rules."})
		return
	}
	arg.WorkspaceID = pgUUID(workspaceID)
	rule, err := h.Queries.CreateAutomodRule(r.Context(), arg)
	if err != nil {
		h.unavailable(w, r, "create automod rule", err)
		return
	}
	h.record(r, rule.WorkspaceID, audit.AutomodRuleChanged, "automod_rule", uuid(rule.ID).String(),
		map[string]any{"name": rule.Name, "change": "created"})
	httpx.WriteJSON(w, http.StatusCreated, automodAPI(rule))
}

// adminRule loads a rule of a workspace the user administers.
func (h *Handlers) adminRule(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.AutomodRule, bool) {
	rule, err := h.Queries.GetAutomodRule(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such rule."})
		return rule, false
	}
	if err != nil {
		h.unavailable(w, r, "get automod rule", err)
		return rule, false
	}
	return rule, h.requireWorkspaceAdmin(w, r, uuid(rule.WorkspaceID), user, "Only the workspace's owners and admins change its AutoMod rules.")
}

// UpdateAutomodRule implements api.ServerInterface.
func (h *Handlers) UpdateAutomodRule(w http.ResponseWriter, r *http.Request, ruleID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.AutomodRuleInput
	if !decode(w, r, &in) {
		return
	}
	rule, ok := h.adminRule(w, r, ruleID, p.User)
	if !ok {
		return
	}
	arg, problem := automodInput(in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	rule, err := h.Queries.UpdateAutomodRule(r.Context(), store.UpdateAutomodRuleParams{
		ID: rule.ID, Name: arg.Name, Kind: arg.Kind, Config: arg.Config, Action: arg.Action,
		ExemptRoles: arg.ExemptRoles, Enabled: arg.Enabled,
	})
	if err != nil {
		h.unavailable(w, r, "update automod rule", err)
		return
	}
	h.record(r, rule.WorkspaceID, audit.AutomodRuleChanged, "automod_rule", uuid(rule.ID).String(),
		map[string]any{"name": rule.Name, "change": "updated"})
	httpx.WriteJSON(w, http.StatusOK, automodAPI(rule))
}

// DeleteAutomodRule implements api.ServerInterface.
func (h *Handlers) DeleteAutomodRule(w http.ResponseWriter, r *http.Request, ruleID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rule, ok := h.adminRule(w, r, ruleID, p.User)
	if !ok {
		return
	}
	if _, err := h.Queries.DeleteAutomodRule(r.Context(), rule.ID); err != nil {
		h.unavailable(w, r, "delete automod rule", err)
		return
	}
	h.record(r, rule.WorkspaceID, audit.AutomodRuleChanged, "automod_rule", uuid(rule.ID).String(),
		map[string]any{"name": rule.Name, "change": "deleted"})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------- reports ---

// ReportEvent is the data of report.created: the workspace's moderators
// refresh their queue.
type ReportEvent struct {
	WorkspaceID string `json:"workspace_id"`
}

// ReportMessage implements api.ServerInterface.
func (h *Handlers) ReportMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.ReportMessageJSONBody
	if !decode(w, r, &in) {
		return
	}
	reason := ""
	if in.Reason != nil {
		reason = strings.TrimSpace(*in.Reason)
	}
	if utf8.RuneCountInString(reason) > 1000 {
		badRequest(w, r, "The reason is longer than 1000 characters.")
		return
	}
	c, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if m.DeletedAt.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "The message was deleted."})
		return
	}
	if m.AuthorID == p.User.ID {
		badRequest(w, r, "You cannot report your own message.")
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		n, err := q.CreateReport(r.Context(), store.CreateReportParams{
			WorkspaceID: c.WorkspaceID, MessageID: m.ID, ReporterID: p.User.ID, Reason: reason,
		})
		if err != nil || n == 0 {
			return err
		}
		return emit(r.Context(), q, events.ReportCreated, ReportEvent{WorkspaceID: uuid(c.WorkspaceID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "report message", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// flagMessage records AutoMod's reports of a message just sent.
func flagMessage(ctx context.Context, q *store.Queries, c store.Channel, message openapi_types.UUID, rules []string) error {
	for _, rule := range rules {
		if _, err := q.CreateReport(ctx, store.CreateReportParams{
			WorkspaceID: c.WorkspaceID, MessageID: pgUUID(message), RuleName: rule,
		}); err != nil {
			return err
		}
	}
	if len(rules) == 0 {
		return nil
	}
	return emit(ctx, q, events.ReportCreated, ReportEvent{WorkspaceID: uuid(c.WorkspaceID).String()})
}

// reportVisible says whether a moderator may see and act on a reported
// message: a conversation's messages only to its own people.
func (h *Handlers) reportVisible(ctx context.Context, user store.User, m store.GetMessagesByIDsRow) (bool, error) {
	if m.ChannelKind != KindDirect && m.ChannelKind != KindGroup {
		return true, nil
	}
	role, err := h.Queries.GetMemberRole(ctx, store.GetMemberRoleParams{ChannelID: m.ChannelID, UserID: user.ID})
	return role != "", err
}

// ListReports implements api.ServerInterface.
func (h *Handlers) ListReports(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, params api.ListReportsParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins see its reports.") {
		return
	}
	open := params.Status == nil || *params.Status == api.ListReportsParamsStatusOpen
	rows, err := h.Queries.ListReports(r.Context(), store.ListReportsParams{WorkspaceID: pgUUID(workspaceID), Open: open})
	if err != nil {
		h.unavailable(w, r, "list reports", err)
		return
	}
	ids := make([]pgtype.UUID, len(rows))
	for i, row := range rows {
		ids[i] = row.MessageID
	}
	byRow, byMsg, err := h.messagesByID(r.Context(), p.User.ID, ids)
	if err != nil {
		h.unavailable(w, r, "load reported messages", err)
		return
	}
	out := make([]api.Report, 0, len(rows))
	for _, row := range rows {
		m, ok := byRow[uuid(row.MessageID)]
		if !ok {
			continue
		}
		if visible, err := h.reportVisible(r.Context(), p.User, m); err != nil {
			h.unavailable(w, r, "check reported message", err)
			return
		} else if !visible {
			continue
		}
		rep := api.Report{
			Id: uuid(row.ID), Message: byMsg[uuid(row.MessageID)],
			Channel:  searchChannel(m.ChannelID, m.WorkspaceID, m.ChannelName, m.ChannelKind),
			RuleName: row.RuleName, Reason: row.Reason, Status: api.ReportStatus(row.Status),
			Action: api.ReportAction(row.Action), CreatedAt: row.CreatedAt, Reports: int(row.OpenReports),
		}
		if row.ReporterID.Valid {
			rep.Reporter = &api.Author{Id: uuid(row.ReporterID), DisplayName: row.ReporterName.String}
		}
		out = append(out, rep)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.Report{"reports": out})
}

// ResolveReport implements api.ServerInterface.
func (h *Handlers) ResolveReport(w http.ResponseWriter, r *http.Request, reportID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.ResolveReportJSONBody
	if !decode(w, r, &in) {
		return
	}
	report, err := h.Queries.GetReport(r.Context(), pgUUID(reportID))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such report."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get report", err)
		return
	}
	if !h.requireWorkspaceAdmin(w, r, uuid(report.WorkspaceID), p.User, "Only the workspace's owners and admins resolve reports.") {
		return
	}
	msgs, err := h.Queries.GetMessagesByIDs(r.Context(), []pgtype.UUID{report.MessageID})
	if err != nil || len(msgs) == 0 {
		h.unavailable(w, r, "get reported message", err)
		return
	}
	m := msgs[0]
	if visible, err := h.reportVisible(r.Context(), p.User, m); err != nil {
		h.unavailable(w, r, "check reported message", err)
		return
	} else if !visible {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such report."})
		return
	}
	status, action := "resolved", ""
	var until time.Time
	switch in.Action {
	case api.ResolveReportJSONBodyActionDismiss:
		status, action = "dismissed", "none"
	case api.ResolveReportJSONBodyActionDelete:
		action = "deleted"
	case api.ResolveReportJSONBodyActionTimeout:
		action = "timeout"
		minutes := 60
		if in.TimeoutMinutes != nil {
			minutes = *in.TimeoutMinutes
		}
		if minutes < 1 || time.Duration(minutes)*time.Minute > MaxTimeout {
			badRequest(w, r, "timeout_minutes must be between 1 and 40320.")
			return
		}
		until = time.Now().Add(time.Duration(minutes) * time.Minute)
		role, err := h.Queries.GetWorkspaceRole(r.Context(), store.GetWorkspaceRoleParams{WorkspaceID: report.WorkspaceID, UserID: m.AuthorID})
		if err != nil {
			h.unavailable(w, r, "get author role", err)
			return
		}
		if isWorkspaceAdmin(role) {
			forbidden(w, r, httpx.CodeForbidden, "Owners and admins cannot be timed out.")
			return
		}
	default:
		badRequest(w, r, "action must be dismiss, delete or timeout.")
		return
	}
	var resolved []store.MessageReport
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		resolved, err = q.ResolveReports(r.Context(), store.ResolveReportsParams{
			MessageID: report.MessageID, Status: status, Action: action, ResolvedBy: p.User.ID,
		})
		if err != nil {
			return err
		}
		switch action {
		case "deleted":
			if !m.DeletedAt.Valid {
				if _, err := q.DeleteMessage(r.Context(), store.DeleteMessageParams{ID: m.ID, DeletedBy: p.User.ID}); err != nil {
					return err
				}
				ref := MessageRef{ID: uuid(m.ID).String(), ChannelID: uuid(m.ChannelID).String()}
				if m.RootID.Valid {
					ref.RootID = uuid(m.RootID).String()
				}
				if err := emit(r.Context(), q, events.MessageDeleted, ref); err != nil {
					return err
				}
			}
		case "timeout":
			if _, err := q.SetMemberTimeout(r.Context(), store.SetMemberTimeoutParams{
				WorkspaceID: report.WorkspaceID, UserID: m.AuthorID, Until: pgtype.Timestamptz{Time: until, Valid: true},
			}); err != nil {
				return err
			}
			if err := emit(r.Context(), q, events.WorkspaceUpdated, WorkspaceEvent{WorkspaceID: uuid(report.WorkspaceID).String()}); err != nil {
				return err
			}
		}
		return emit(r.Context(), q, events.ReportCreated, ReportEvent{WorkspaceID: uuid(report.WorkspaceID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "resolve report", err)
		return
	}
	h.record(r, report.WorkspaceID, audit.ReportResolved, "message", uuid(m.ID).String(), map[string]any{
		"action": action, "author": m.AuthorName, "channel": m.ChannelName, "reports": len(resolved),
	})
	out := api.Report{
		Id: uuid(report.ID), Channel: searchChannel(m.ChannelID, m.WorkspaceID, m.ChannelName, m.ChannelKind),
		Message: messageOf(m), RuleName: report.RuleName, Reason: report.Reason,
		Status: api.ReportStatus(status), Action: api.ReportAction(action), CreatedAt: report.CreatedAt,
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// --------------------------------------------------------------- timeouts ---

// SetMemberTimeout implements api.ServerInterface.
func (h *Handlers) SetMemberTimeout(w http.ResponseWriter, r *http.Request, workspaceID, userID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetMemberTimeoutJSONBody
	if !decode(w, r, &in) {
		return
	}
	if !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins time members out.") {
		return
	}
	var until pgtype.Timestamptz
	if in.Until != nil {
		if !in.Until.After(time.Now()) || time.Until(*in.Until) > MaxTimeout {
			badRequest(w, r, "A timeout ends within 28 days.")
			return
		}
		until = pgtype.Timestamptz{Time: *in.Until, Valid: true}
	}
	role, err := h.Queries.GetWorkspaceRole(r.Context(), store.GetWorkspaceRoleParams{WorkspaceID: pgUUID(workspaceID), UserID: pgUUID(userID)})
	if err != nil {
		h.unavailable(w, r, "get member role", err)
		return
	}
	switch {
	case role == "":
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "Not a member of this workspace."})
		return
	case isWorkspaceAdmin(role):
		forbidden(w, r, httpx.CodeForbidden, "Owners and admins cannot be timed out.")
		return
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if _, err := q.SetMemberTimeout(r.Context(), store.SetMemberTimeoutParams{
			WorkspaceID: pgUUID(workspaceID), UserID: pgUUID(userID), Until: until,
		}); err != nil {
			return err
		}
		return emit(r.Context(), q, events.WorkspaceUpdated, WorkspaceEvent{WorkspaceID: workspaceID.String()})
	})
	if err != nil {
		h.unavailable(w, r, "set timeout", err)
		return
	}
	detail := map[string]any{"until": nil}
	if until.Valid {
		detail["until"] = until.Time.UTC().Format(time.RFC3339)
	}
	h.record(r, pgUUID(workspaceID), audit.MemberTimedOut, "user", userID.String(), detail)
	w.WriteHeader(http.StatusNoContent)
}
