// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/barisshn35/cenacle/server/internal/store"
)

// Keys returns the installation's VAPID key pair, made and stored on first use
// (every instance then signs with the same keys).
func Keys(ctx context.Context, q store.Querier) (public, private string, err error) {
	k, err := q.GetPushKeys(ctx)
	if err == nil {
		return k.PublicKey, k.PrivateKey, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}
	pub, priv, err := GenerateKeys()
	if err != nil {
		return "", "", err
	}
	// Another instance may have been quicker: read back what was stored.
	if err := q.InsertPushKeys(ctx, store.InsertPushKeysParams{PublicKey: pub, PrivateKey: priv}); err != nil {
		return "", "", err
	}
	k, err = q.GetPushKeys(ctx)
	return k.PublicKey, k.PrivateKey, err
}
