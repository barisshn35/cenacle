// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// The posting rules: what every way of writing a message in a person's name
// goes through (sending, commands, notices, scheduled messages, messages from
// federated servers, workflow messages with variables). Each rule is one
// function without a request, so paths without one (background jobs,
// federation) apply the same rules as the handlers.

// postRefusal is why a posting rule refuses a message.
type postRefusal struct {
	status int
	code   string
	detail string
	// retryAfter in seconds (0: no hint).
	retryAfter int
}

func (p *postRefusal) write(w http.ResponseWriter, r *http.Request) {
	if p.retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(p.retryAfter))
	}
	httpx.WriteProblem(w, r, httpx.Problem{Status: p.status, Code: p.code, Detail: p.detail})
}

// postVerdict is what an allowed message carries on.
type postVerdict struct {
	// noGroups: the author's group mentions notify no one (the scheme's rules).
	noGroups bool
	// flags are the AutoMod rules that report the message once it is sent.
	flags []string
}

// postOptions tune the rules to the way of writing.
type postOptions struct {
	// slowMode: the channel's slow mode counts (a message a person sends
	// now; not one sent later for them or a notice).
	slowMode bool
	// anyChannel: the channel was chosen by its workspace's admins (a
	// workflow), so who may post there is not checked again.
	anyChannel bool
	// granted are mentions of many the text may make whatever the author's
	// rights (written by an admin, see broadcasts).
	granted []string
}

// postingRules applies the posting rules to text the user writes in c with
// role: the channel lets them post, they are not timed out, slow mode, their
// right to mention everyone, and AutoMod (not in encrypted channels, which
// it cannot read). A refusal is returned, not an error.
func postingRules(ctx context.Context, q store.Querier, c store.Channel, role access, user store.User, text string, o postOptions) (postVerdict, *postRefusal, error) {
	var v postVerdict
	if !o.anyChannel && !canPost(c, role) {
		return v, &postRefusal{status: http.StatusForbidden, code: CodeReadOnlyChannel,
			detail: "You cannot send messages in this channel."}, nil
	}
	if no, err := memberTimeout(ctx, q, c.WorkspaceID, user); no != nil || err != nil {
		return v, no, err
	}
	if o.slowMode {
		if no, err := slowMode(ctx, q, c, role, user); no != nil || err != nil {
			return v, no, err
		}
	}
	noGroups, no, err := broadcastRule(ctx, q, c, role, text, o.granted)
	if no != nil || err != nil {
		return v, no, err
	}
	v.noGroups = noGroups
	if !c.Encrypted {
		if v.flags, no, err = automodRules(ctx, q, c, role, text); no != nil || err != nil {
			return v, no, err
		}
	}
	return v, nil, nil
}

// postingAllowed is postingRules for a request: a refusal is answered.
func (h *Handlers) postingAllowed(w http.ResponseWriter, r *http.Request, c store.Channel, role access, user store.User, text string, o postOptions) (postVerdict, bool) {
	v, no, err := postingRules(r.Context(), h.Queries, c, role, user, text, o)
	if err != nil {
		h.unavailable(w, r, "posting rules", err)
		return v, false
	}
	if no != nil {
		no.write(w, r)
		return v, false
	}
	return v, true
}

// memberTimeout refuses a user a moderator timed out in the workspace.
func memberTimeout(ctx context.Context, q store.Querier, workspace pgtype.UUID, user store.User) (*postRefusal, error) {
	until, err := q.GetMemberTimeout(ctx, store.GetMemberTimeoutParams{WorkspaceID: workspace, UserID: user.ID})
	if err != nil && !isNoRows(err) {
		return nil, err
	}
	if until.Valid && until.Time.After(time.Now()) {
		return &postRefusal{status: http.StatusForbidden, code: CodeTimedOut,
			detail: "A moderator has paused your messages in this workspace until " +
				until.Time.UTC().Format(time.RFC3339) + ".",
			retryAfter: int(time.Until(until.Time).Seconds()) + 1}, nil
	}
	return nil, nil
}

// slowMode refuses a member who must wait (managers are exempt).
func slowMode(ctx context.Context, q store.Querier, c store.Channel, role access, user store.User) (*postRefusal, error) {
	if c.SlowModeSeconds <= 0 || canManage(c, role) || role.admin() {
		return nil, nil
	}
	last, err := q.LastMessageAt(ctx, store.LastMessageAtParams{ChannelID: c.ID, AuthorID: user.ID})
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	wait := time.Until(last.Add(time.Duration(c.SlowModeSeconds) * time.Second))
	if wait <= 0 {
		return nil, nil
	}
	secs := int(wait.Seconds()) + 1
	return &postRefusal{status: http.StatusTooManyRequests, code: CodeSlowMode, retryAfter: secs,
		detail: fmt.Sprintf("Slow mode: wait %d seconds before your next message here.", secs)}, nil
}

// broadcastRule checks that the author may mention everyone in text here,
// and says whether their group mentions notify no one (the scheme's rules).
func broadcastRule(ctx context.Context, q store.Querier, c store.Channel, role access, text string, granted []string) (bool, *postRefusal, error) {
	ws, err := q.GetWorkspace(ctx, c.WorkspaceID)
	if err != nil {
		return false, nil, err
	}
	scheme := permissionsOf(ws.Permissions)
	asked := slices.DeleteFunc(broadcasts(text), func(b string) bool { return slices.Contains(granted, b) })
	if len(asked) > 0 && (!scheme.Allows(PermBroadcast, role.ws) || !canBroadcastHere(c, role)) {
		return false, &postRefusal{status: http.StatusForbidden, code: CodeNoBroadcast,
			detail: "You may not mention everyone in this channel."}, nil
	}
	return !scheme.Allows(PermGroupMentions, role.ws), nil, nil
}

// automodRules checks text against the workspace's AutoMod rules: a blocking
// rule refuses it; flagging rules are returned to be reported once it is
// sent. Conversations are never flagged: a report would show their text to
// moderators who are not in them (blocking reveals nothing).
func automodRules(ctx context.Context, q store.Querier, c store.Channel, role access, text string) ([]string, *postRefusal, error) {
	if text == "" {
		return nil, nil, nil
	}
	rules, err := q.ListEnabledAutomodRules(ctx, c.WorkspaceID)
	if err != nil {
		return nil, nil, err
	}
	var flags []string
	for _, rule := range rules {
		if slices.Contains(rule.ExemptRoles, role.ws) || !automodMatch(rule, text) {
			continue
		}
		if rule.Action == "block" {
			return nil, &postRefusal{status: http.StatusBadRequest, code: CodeAutomodBlocked,
				detail: "The workspace's rule “" + rule.Name + "” does not allow this message."}, nil
		}
		if !isConversation(c) {
			flags = append(flags, rule.Name)
		}
	}
	return flags, nil, nil
}
