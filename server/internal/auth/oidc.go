// SPDX-License-Identifier: Apache-2.0

package auth

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// IdentityProvider is the OpenID Provider the chat server signs users in with.
// Discovery happens on first use and is retried until it succeeds, so the chat
// server can start before Cenacle ID.
type IdentityProvider struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	// HTTPClient is used for every server-to-IdP request.
	HTTPClient *http.Client

	mu       sync.Mutex
	provider *oidc.Provider
	meta     providerMetadata
}

type providerMetadata struct {
	EndSessionEndpoint string `json:"end_session_endpoint"`
	// RFC 9207: the provider adds "iss" to authorization responses.
	AuthorizationResponseIss bool `json:"authorization_response_iss_parameter_supported"`
}

// scopes requested at sign-in. The ID token carries the subject; e-mail and
// name come from userinfo (see ADR 0002).
var scopes = []string{oidc.ScopeOpenID, "email", "profile", "groups"}

func (p *IdentityProvider) clientContext(ctx context.Context) context.Context {
	return oidc.ClientContext(ctx, p.HTTPClient)
}

func (p *IdentityProvider) discover(ctx context.Context) (*oidc.Provider, providerMetadata, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.provider != nil {
		return p.provider, p.meta, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// The provider keeps the HTTP client (not the deadline) for later JWKS fetches.
	provider, err := oidc.NewProvider(p.clientContext(ctx), p.Issuer)
	if err != nil {
		return nil, providerMetadata{}, fmt.Errorf("oidc discovery: %w", err)
	}
	var meta providerMetadata
	if err := provider.Claims(&meta); err != nil {
		return nil, providerMetadata{}, fmt.Errorf("oidc discovery metadata: %w", err)
	}
	p.provider, p.meta = provider, meta
	return provider, meta, nil
}

func (p *IdentityProvider) oauth2Config(provider *oidc.Provider) *oauth2.Config {
	endpoint := provider.Endpoint()
	// Cenacle ID accepts client_secret_basic only (ADR 0002).
	endpoint.AuthStyle = oauth2.AuthStyleInHeader
	return &oauth2.Config{
		ClientID:     p.ClientID,
		ClientSecret: p.ClientSecret,
		Endpoint:     endpoint,
		RedirectURL:  p.RedirectURL,
		Scopes:       scopes,
	}
}

// EndSessionURL is the IdP sign-out page that returns to postLogoutRedirect,
// or "" when the provider has not been discovered or has none.
func (p *IdentityProvider) EndSessionURL(postLogoutRedirect string) string {
	p.mu.Lock()
	endpoint := p.meta.EndSessionEndpoint
	p.mu.Unlock()
	if endpoint == "" {
		return ""
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return ""
	}
	q := u.Query()
	q.Set("client_id", p.ClientID)
	q.Set("post_logout_redirect_uri", postLogoutRedirect)
	u.RawQuery = q.Encode()
	return u.String()
}

// BackchannelTransport sends requests addressed to the public issuer origin
// to an internal address instead (for example http://idp:8190 inside the
// Compose network), keeping the public Host so that the IdP sees the same
// request as through the reverse proxy. Issuer checks still use the public URL.
type BackchannelTransport struct {
	Public   *url.URL
	Internal *url.URL
	Base     http.RoundTripper
}

// RoundTrip implements http.RoundTripper.
func (t *BackchannelTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	if r.URL.Scheme != t.Public.Scheme || r.URL.Host != t.Public.Host {
		return base.RoundTrip(r)
	}
	r2 := r.Clone(r.Context())
	r2.URL.Scheme = t.Internal.Scheme
	r2.URL.Host = t.Internal.Host
	r2.Host = t.Public.Host
	r2.Header.Set("X-Forwarded-Proto", t.Public.Scheme)
	r2.Header.Set("X-Forwarded-Host", t.Public.Host)
	return base.RoundTrip(r2)
}

// NewHTTPClient returns the client for server-to-IdP requests. With a
// backchannel URL, requests to the issuer origin go there instead.
func NewHTTPClient(issuer string, backchannel *url.URL) (*http.Client, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	if backchannel == nil {
		return client, nil
	}
	public, err := url.Parse(issuer)
	if err != nil {
		return nil, fmt.Errorf("issuer: %w", err)
	}
	client.Transport = &BackchannelTransport{Public: public, Internal: backchannel}
	return client, nil
}
