// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
)

// AssistantTokenPrefix starts every personal assistant token (ADR 0056), so it
// is recognizable in logs and secret scanners.
const AssistantTokenPrefix = "cnp_"

// Assistant scopes.
const (
	ScopeAssistantRead  = "read"
	ScopeAssistantDraft = "draft"
)

// MCPPath is the only address an assistant token reaches.
const MCPPath = "/api/mcp"

// CodeAssistantNotAllowed answers requests assistant tokens cannot make.
const CodeAssistantNotAllowed = "assistant_not_allowed"

// AssistantPrincipal is the token behind a request of a person's assistant.
type AssistantPrincipal struct {
	TokenID [16]byte
	Name    string
	Scopes  []string
}

// NewAssistantToken returns a new assistant token and its hash.
func NewAssistantToken() (string, []byte) {
	token, _ := newToken()
	token = AssistantTokenPrefix + token
	return token, hashToken(token)
}

func isAssistantToken(token string) bool { return strings.HasPrefix(token, AssistantTokenPrefix) }

// authenticateAssistant resolves an assistant token: its person, acting
// through it.
func (s *Sessions) authenticateAssistant(ctx context.Context, token string) (Principal, error) {
	if len(token) != len(AssistantTokenPrefix)+43 {
		return Principal{}, ErrNoSession
	}
	row, err := s.Queries.GetActiveAssistantToken(ctx, hashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return Principal{}, ErrNoSession
	}
	if err != nil {
		return Principal{}, fmt.Errorf("get assistant token: %w", err)
	}
	if err := s.Queries.TouchAssistantToken(ctx, row.AssistantToken.ID); err != nil {
		return Principal{}, fmt.Errorf("touch assistant token: %w", err)
	}
	return Principal{User: row.User, Assistant: &AssistantPrincipal{
		TokenID: row.AssistantToken.ID.Bytes, Name: row.AssistantToken.Name, Scopes: row.AssistantToken.Scopes,
	}}, nil
}

// RestrictAssistants lets assistant tokens reach only the MCP endpoint.
func RestrictAssistants(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p, ok := PrincipalFrom(r.Context()); ok && p.Assistant != nil && r.URL.Path != MCPPath {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusForbidden, Code: CodeAssistantNotAllowed,
				Detail: "Assistant tokens reach only " + MCPPath + "."})
			return
		}
		next.ServeHTTP(w, r)
	})
}
