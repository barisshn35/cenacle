// SPDX-License-Identifier: Apache-2.0

package httpx

import (
	"encoding/json"
	"net/http"
)

// ProblemContentType is the RFC 9457 media type.
const ProblemContentType = "application/problem+json"

// Problem is an RFC 9457 problem details object with Cenacle extensions.
//
// Code is a stable, machine-readable identifier (snake_case) that clients
// map to localized messages; Title and Detail are English and meant for
// developers and logs, not for direct display to end users.
type Problem struct {
	Type      string `json:"type"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Detail    string `json:"detail,omitempty"`
	Instance  string `json:"instance,omitempty"`
	Code      string `json:"code"`
	RequestID string `json:"request_id,omitempty"`
}

// Stable problem codes used across the API.
const (
	CodeNotFound         = "not_found"
	CodeMethodNotAllowed = "method_not_allowed"
	CodeInternal         = "internal_error"
	CodeUnavailable      = "service_unavailable"
	CodeBadRequest       = "invalid_request"
	CodeUnauthenticated  = "unauthenticated"
	CodeCrossSite        = "cross_site_request"
	CodeRateLimited      = "rate_limited"
	CodeForbidden        = "forbidden"
)

// WriteProblem writes p as application/problem+json. Missing fields are
// filled in: Type defaults to "about:blank", Title to the status text and
// RequestID to the ID of the current request.
func WriteProblem(w http.ResponseWriter, r *http.Request, p Problem) {
	if p.Status == 0 {
		p.Status = http.StatusInternalServerError
	}
	if p.Type == "" {
		p.Type = "about:blank"
	}
	if p.Title == "" {
		p.Title = http.StatusText(p.Status)
	}
	if p.Code == "" {
		p.Code = CodeInternal
	}
	if p.RequestID == "" {
		p.RequestID = RequestIDFrom(r.Context())
	}

	h := w.Header()
	h.Set("Content-Type", ProblemContentType)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(p)
}

// NotFound is an http.HandlerFunc for unknown routes.
func NotFound(w http.ResponseWriter, r *http.Request) {
	WriteProblem(w, r, Problem{
		Status: http.StatusNotFound,
		Code:   CodeNotFound,
		Detail: "No resource exists at this path.",
	})
}

// MethodNotAllowed is an http.HandlerFunc for known routes with a wrong method.
func MethodNotAllowed(w http.ResponseWriter, r *http.Request) {
	WriteProblem(w, r, Problem{
		Status: http.StatusMethodNotAllowed,
		Code:   CodeMethodNotAllowed,
		Detail: "The resource does not support this HTTP method.",
	})
}

// WriteJSON writes v as an uncacheable JSON response.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
