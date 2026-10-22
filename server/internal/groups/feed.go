// SPDX-License-Identifier: Apache-2.0

package groups

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// AuthService is the auth_service of accounts from Cenacle ID.
const AuthService = "cenacle-id"

// DB starts transactions (pgxpool.Pool).
type DB interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Publisher tells open connections that a person's sessions ended.
type Publisher interface {
	Publish(ctx context.Context, typ string, data any) error
}

// Feed follows Cenacle ID's directory feed: names, addresses, groups and
// roles of people who use the chat, and deactivations (their sessions end
// at once). People who never signed in are left alone.
type Feed struct {
	HTTP         *http.Client
	Issuer       string // the feed is <issuer>/directory/v1/changes
	ClientID     string
	ClientSecret string
	DB           DB
	Queries      *store.Queries
	Ephemeral    Publisher // optional
	AdminEmail   string
	Log          *slog.Logger
}

type feedUser struct {
	Sub           string   `json:"sub"`
	Name          string   `json:"name"`
	Email         string   `json:"email"`
	EmailVerified bool     `json:"email_verified"`
	Username      string   `json:"preferred_username"`
	Groups        []string `json:"groups"`
	Role          string   `json:"cenacle_role"`
	Disabled      bool     `json:"disabled"`
}

type feedPage struct {
	Users []feedUser `json:"users"`
	Next  string     `json:"next"`
	More  bool       `json:"more"`
}

// Sync reads the feed from the saved cursor to the end and applies it; it
// returns how many people of the chat changed.
func (f *Feed) Sync(ctx context.Context) (int, error) {
	state, err := f.Queries.GetDirectorySyncState(ctx)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	cursor := state.Cursor
	changed := 0
	for range 100 { // at most 50 000 accounts a round
		page, err := f.fetch(ctx, cursor)
		if err != nil {
			return changed, err
		}
		for _, u := range page.Users {
			ok, err := f.apply(ctx, u)
			if err != nil {
				return changed, err
			}
			if ok {
				changed++
			}
		}
		cursor = page.Next
		if err := f.Queries.SaveDirectorySyncState(ctx, cursor); err != nil {
			return changed, err
		}
		if !page.More {
			break
		}
	}
	return changed, nil
}

func (f *Feed) fetch(ctx context.Context, cursor string) (feedPage, error) {
	u := strings.TrimSuffix(f.Issuer, "/") + "/directory/v1/changes"
	if cursor != "" {
		u += "?after=" + url.QueryEscape(cursor)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return feedPage{}, err
	}
	req.SetBasicAuth(url.QueryEscape(f.ClientID), url.QueryEscape(f.ClientSecret))
	res, err := f.HTTP.Do(req)
	if err != nil {
		return feedPage{}, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return feedPage{}, fmt.Errorf("directory feed: status %d (is directory_feed set for the client?)", res.StatusCode)
	}
	var page feedPage
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(&page); err != nil {
		return feedPage{}, fmt.Errorf("directory feed: %w", err)
	}
	return page, nil
}

func (f *Feed) apply(ctx context.Context, u feedUser) (bool, error) {
	user, err := f.Queries.GetUserByAuth(ctx, store.GetUserByAuthParams{AuthService: AuthService, AuthData: u.Sub})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // not a chat user (yet)
	}
	if err != nil {
		return false, err
	}
	ended := false
	err = inTx(ctx, f.DB, func(q *store.Queries) error {
		changed, err := q.SetUserDeactivated(ctx, store.SetUserDeactivatedParams{ID: user.ID, Deactivated: u.Disabled})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if u.Disabled {
			// Gone from the directory or disabled: no more sessions, nowhere.
			if changed.Valid {
				if _, err := q.DeleteOtherSessions(ctx, store.DeleteOtherSessionsParams{
					UserID: user.ID, Keep: pgtype.UUID{Valid: true}, // the nil UUID: all of them
				}); err != nil {
					return err
				}
				ended = true
			}
			return nil
		}
		name := strings.TrimSpace(u.Name)
		if name == "" {
			name = user.DisplayName
		}
		if err := q.UpdateUserProfile(ctx, store.UpdateUserProfileParams{
			ID: user.ID, Email: u.Email, EmailVerified: u.EmailVerified, DisplayName: name,
		}); err != nil {
			return err
		}
		user.Email, user.EmailVerified, user.DisplayName = u.Email, u.EmailVerified, name
		return Apply(ctx, q, user, Profile{Username: u.Username, Role: u.Role, Groups: u.Groups}, f.AdminEmail)
	})
	if err != nil {
		return false, err
	}
	if ended && f.Ephemeral != nil {
		if err := f.Ephemeral.Publish(ctx, events.SessionsEnded, map[string]string{"user_id": id(user.ID)}); err != nil {
			f.Log.WarnContext(ctx, "publish sessions ended", "error", err)
		}
	}
	return true, nil
}

func inTx(ctx context.Context, db DB, fn func(q *store.Queries) error) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(store.New(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
