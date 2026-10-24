// SPDX-License-Identifier: AGPL-3.0-only

package storage

import (
	"context"
	"net/http"
	"net/url"
)

// CreateContainer makes the container of a test (Azurite starts empty).
func (a *Azure) CreateContainer(ctx context.Context) error {
	resp, err := a.do(ctx, http.MethodPut, "", url.Values{"restype": {"container"}}, nil, nil)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}
