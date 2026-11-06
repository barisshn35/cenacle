// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
)

// BotTokenPrefix starts every bot token, so it is recognizable in logs and
// secret scanners.
const BotTokenPrefix = "cnb_"

// Bot scopes.
const (
	ScopeMessagesRead  = "messages:read"
	ScopeMessagesWrite = "messages:write"
)

// CodeBotNotAllowed answers requests bots cannot make.
const CodeBotNotAllowed = "bot_not_allowed"

// BotPrincipal is the bot behind a request authenticated with a bot token.
type BotPrincipal struct {
	ID          [16]byte
	WorkspaceID [16]byte
	TokenID     [16]byte
	Scopes      []string
}

// NewBotToken returns a new bot token and its hash.
func NewBotToken() (string, []byte) {
	token, _ := newToken()
	token = BotTokenPrefix + token
	return token, hashToken(token)
}

// HashSecret hashes a token or webhook secret for lookup.
func HashSecret(secret string) []byte { return hashToken(secret) }

// authenticateBot resolves a bot token.
func (s *Sessions) authenticateBot(ctx context.Context, token string) (Principal, error) {
	if len(token) != len(BotTokenPrefix)+43 {
		return Principal{}, ErrNoSession
	}
	row, err := s.Queries.GetActiveBotToken(ctx, hashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return Principal{}, ErrNoSession
	}
	if err != nil {
		return Principal{}, fmt.Errorf("get bot token: %w", err)
	}
	if err := s.Queries.TouchBotToken(ctx, row.BotToken.ID); err != nil {
		return Principal{}, fmt.Errorf("touch bot token: %w", err)
	}
	return Principal{User: row.User, Bot: &BotPrincipal{
		ID: row.Bot.ID.Bytes, WorkspaceID: row.Bot.WorkspaceID.Bytes, TokenID: row.BotToken.ID.Bytes,
		Scopes: row.BotToken.Scopes,
	}}, nil
}

// botRoutes are what bots may call, with the scope each needs.
var botRoutes = []struct {
	method string
	path   *regexp.Regexp
	scope  string
}{
	{http.MethodGet, regexp.MustCompile(`^/api/channels$`), ScopeMessagesRead},
	{http.MethodGet, regexp.MustCompile(`^/api/channels/[0-9a-fA-F-]{36}/messages$`), ScopeMessagesRead},
	{http.MethodPost, regexp.MustCompile(`^/api/channels/[0-9a-fA-F-]{36}/messages$`), ScopeMessagesWrite},
	{http.MethodPut, regexp.MustCompile(`^/api/channels/[0-9a-fA-F-]{36}/messages/[0-9a-fA-F-]{36}/reactions/[^/]+$`), ScopeMessagesWrite},
	{http.MethodDelete, regexp.MustCompile(`^/api/channels/[0-9a-fA-F-]{36}/messages/[0-9a-fA-F-]{36}/reactions/[^/]+$`), ScopeMessagesWrite},
	{http.MethodPost, regexp.MustCompile(`^/api/channels/[0-9a-fA-F-]{36}/files$`), ScopeMessagesWrite},
	{http.MethodPost, regexp.MustCompile(`^/api/files/[0-9a-fA-F-]{36}/complete$`), ScopeMessagesWrite},
	{http.MethodDelete, regexp.MustCompile(`^/api/files/[0-9a-fA-F-]{36}$`), ScopeMessagesWrite},
	{http.MethodGet, regexp.MustCompile(`^/api/channels/[0-9a-fA-F-]{36}/files$`), ScopeMessagesRead},
	{http.MethodGet, regexp.MustCompile(`^/api/files/[0-9a-fA-F-]{36}/(content|thumbnail)$`), ScopeMessagesRead},
}

// RestrictBots lets bot tokens reach only the bot API, within their scopes.
func RestrictBots(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok || p.Bot == nil {
			next.ServeHTTP(w, r)
			return
		}
		for _, route := range botRoutes {
			if r.Method == route.method && route.path.MatchString(r.URL.Path) {
				if !slices.Contains(p.Bot.Scopes, route.scope) {
					httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusForbidden, Code: CodeBotNotAllowed,
						Detail: "The token lacks the " + route.scope + " scope."})
					return
				}
				next.ServeHTTP(w, r)
				return
			}
		}
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusForbidden, Code: CodeBotNotAllowed,
			Detail: "Bots cannot use this operation."})
	})
}

func isBotToken(token string) bool { return strings.HasPrefix(token, BotTokenPrefix) }
