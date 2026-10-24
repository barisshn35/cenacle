// SPDX-License-Identifier: AGPL-3.0-only

package storage

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// AzureConfig describes a container of Azure Blob Storage.
type AzureConfig struct {
	Account   string
	Key       string // the account's shared key (base64)
	Container string
	// Endpoint is the blob service, default https://<account>.blob.core.windows.net
	// (other clouds; Azurite: http://host:10000/<account>).
	Endpoint string
	// Client sends the requests (default: a client with a timeout per request).
	Client *http.Client
}

// Azure is a container of Azure Blob Storage, spoken to with its REST API and
// a shared key. Browsers upload to the server, which writes the blob.
type Azure struct {
	Receiver
	account string
	key     []byte
	base    *url.URL // the container
	client  *http.Client
}

// azureVersion pins the REST API version.
const azureVersion = "2021-12-02"

// azureBlock is the size of the blocks of a large upload; smaller objects go
// in one request.
const azureBlock = 8 << 20

// NewAzure prepares the container client (nothing is sent yet).
func NewAzure(c AzureConfig, uploadURL string, tickets Tickets) (*Azure, error) {
	if c.Account == "" || c.Key == "" || c.Container == "" {
		return nil, errors.New("storage: Azure needs the account, its key and the container")
	}
	key, err := base64.StdEncoding.DecodeString(c.Key)
	if err != nil {
		return nil, errors.New("storage: the Azure key is not base64")
	}
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = "https://" + c.Account + ".blob.core.windows.net"
	}
	u, err := url.Parse(strings.TrimSuffix(endpoint, "/") + "/" + url.PathEscape(c.Container))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("storage: the Azure endpoint must be an http(s) URL, got %q", endpoint)
	}
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	a := &Azure{account: c.Account, key: key, base: u, client: client}
	a.Receiver = Receiver{tickets: tickets, url: uploadURL, store: a}
	return a, nil
}

// azureError is an error response of the service.
type azureError struct {
	Status int
	Code   string
}

func (e *azureError) Error() string {
	return fmt.Sprintf("storage: Azure answered %d %s", e.Status, e.Code)
}

// do sends a signed request; query and headers may be nil.
func (a *Azure) do(ctx context.Context, method, key string, query url.Values, header http.Header, body []byte) (*http.Response, error) {
	u := *a.base
	if key != "" {
		u.Path += "/" + key
		u.RawPath = a.base.EscapedPath() + "/" + escapeKey(key)
	}
	u.RawQuery = query.Encode()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), r) //nolint:gosec // the operator's configured endpoint
	if err != nil {
		return nil, err
	}
	for k, vs := range header {
		for _, v := range vs {
			req.Header.Add(k, v) // canonical keys, as sign reads them
		}
	}
	req.Header.Set("x-ms-date", time.Now().UTC().Format(http.TimeFormat))
	req.Header.Set("x-ms-version", azureVersion)
	req.ContentLength = int64(len(body))
	req.Header.Set("Authorization", "SharedKey "+a.account+":"+a.sign(req))
	resp, err := a.client.Do(req) //nolint:gosec // the operator's configured endpoint
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		defer func() { _ = resp.Body.Close() }()
		e := &azureError{Status: resp.StatusCode, Code: resp.Header.Get("x-ms-error-code")}
		if e.Status == http.StatusNotFound && (e.Code == "BlobNotFound" || method == http.MethodHead && key != "") {
			return nil, ErrNotFound
		}
		return nil, e
	}
	return resp, nil
}

// escapeKey escapes each segment of a key.
func escapeKey(key string) string {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

// sign computes the Shared Key signature of a request.
func (a *Azure) sign(req *http.Request) string {
	h := req.Header
	length := ""
	if req.ContentLength > 0 {
		length = strconv.FormatInt(req.ContentLength, 10)
	}
	var ms []string
	for k := range h {
		if lk := strings.ToLower(k); strings.HasPrefix(lk, "x-ms-") {
			ms = append(ms, lk)
		}
	}
	sort.Strings(ms)
	var canon strings.Builder
	for _, k := range ms {
		canon.WriteString(k + ":" + strings.TrimSpace(h.Get(k)) + "\n")
	}
	resource := "/" + a.account + req.URL.EscapedPath()
	q := req.URL.Query()
	names := make([]string, 0, len(q))
	for k := range q {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		resource += "\n" + strings.ToLower(k) + ":" + strings.Join(vals, ",")
	}
	toSign := strings.Join([]string{
		req.Method, h.Get("Content-Encoding"), h.Get("Content-Language"), length, h.Get("Content-MD5"),
		h.Get("Content-Type"), "", h.Get("If-Modified-Since"), h.Get("If-Match"), h.Get("If-None-Match"),
		h.Get("If-Unmodified-Since"), "",
	}, "\n") + "\n" + canon.String() + resource
	mac := hmac.New(sha256.New, a.key)
	mac.Write([]byte(toSign))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// Size implements Store.
func (a *Azure) Size(ctx context.Context, key string) (int64, error) {
	resp, err := a.do(ctx, http.MethodHead, key, nil, nil, nil)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	return resp.ContentLength, nil
}

// Open implements Store: reads are ranged downloads.
func (a *Azure) Open(ctx context.Context, key string) (Object, error) {
	size, err := a.Size(ctx, key)
	if err != nil {
		return nil, err
	}
	return &azureObject{ctx: ctx, a: a, key: key, size: size}, nil
}

// Put implements Store: one request for a small object, blocks for a large
// one.
func (a *Azure) Put(ctx context.Context, key string, r io.Reader, _ int64, contentType string) error {
	buf := make([]byte, azureBlock)
	var ids []string
	for i := 0; ; i++ {
		n, err := io.ReadFull(r, buf)
		last := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
		if err != nil && !last {
			return err
		}
		if i == 0 && last {
			h := http.Header{"x-ms-blob-type": {"BlockBlob"}, "x-ms-blob-content-type": {contentType}}
			resp, err := a.do(ctx, http.MethodPut, key, nil, h, buf[:n])
			if err != nil {
				return err
			}
			return resp.Body.Close()
		}
		if n > 0 {
			id := base64.StdEncoding.EncodeToString(fmt.Appendf(nil, "block-%08d", i))
			resp, err := a.do(ctx, http.MethodPut, key, url.Values{"comp": {"block"}, "blockid": {id}}, nil, buf[:n])
			if err != nil {
				return err
			}
			_ = resp.Body.Close()
			ids = append(ids, id)
		}
		if last {
			break
		}
	}
	var list struct {
		XMLName xml.Name `xml:"BlockList"`
		Latest  []string `xml:"Latest"`
	}
	list.Latest = ids
	body, err := xml.Marshal(list)
	if err != nil {
		return err
	}
	h := http.Header{"x-ms-blob-content-type": {contentType}, "Content-Type": {"application/xml"}}
	resp, err := a.do(ctx, http.MethodPut, key, url.Values{"comp": {"blocklist"}}, h, append([]byte(xml.Header), body...))
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

// Remove implements Store.
func (a *Azure) Remove(ctx context.Context, key string) error {
	resp, err := a.do(ctx, http.MethodDelete, key, nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

// Check implements health.Checker: the container is reachable.
func (a *Azure) Check(ctx context.Context) error {
	resp, err := a.do(ctx, http.MethodHead, "", url.Values{"restype": {"container"}}, nil, nil)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

// Name implements health.Checker.
func (*Azure) Name() string { return "storage" }

// download opens a range of a blob.
func (a *Azure) download(ctx context.Context, key string, off, n int64) (io.ReadCloser, error) {
	h := http.Header{"x-ms-range": {fmt.Sprintf("bytes=%d-%d", off, off+n-1)}}
	resp, err := a.do(ctx, http.MethodGet, key, nil, h, nil)
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// azureObject reads a blob with range requests.
type azureObject struct {
	ctx  context.Context //nolint:containedctx // an open object reads in the context it was opened in
	a    *Azure
	key  string
	size int64
	off  int64
	body io.ReadCloser // the open download for sequential reads
}

func (o *azureObject) ReadAt(p []byte, off int64) (int, error) {
	if off >= o.size {
		return 0, io.EOF
	}
	n := min(int64(len(p)), o.size-off)
	if n == 0 {
		return 0, nil
	}
	body, err := o.a.download(o.ctx, o.key, off, n)
	if err != nil {
		return 0, err
	}
	defer func() { _ = body.Close() }()
	read, err := io.ReadFull(body, p[:n])
	if err == nil && read < len(p) {
		err = io.EOF
	}
	return read, err
}

func (o *azureObject) Read(p []byte) (int, error) {
	if o.off >= o.size {
		return 0, io.EOF
	}
	if o.body == nil {
		body, err := o.a.download(o.ctx, o.key, o.off, o.size-o.off)
		if err != nil {
			return 0, err
		}
		o.body = body
	}
	n, err := o.body.Read(p)
	o.off += int64(n)
	if errors.Is(err, io.EOF) && o.off < o.size {
		err = io.ErrUnexpectedEOF
	}
	return n, err
}

func (o *azureObject) Seek(offset int64, whence int) (int64, error) {
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = o.off + offset
	case io.SeekEnd:
		abs = o.size + offset
	default:
		return 0, errors.New("storage: bad whence")
	}
	if abs < 0 {
		return 0, errors.New("storage: negative position")
	}
	if abs != o.off && o.body != nil {
		_ = o.body.Close()
		o.body = nil
	}
	o.off = abs
	return abs, nil
}

func (o *azureObject) Close() error {
	if o.body != nil {
		return o.body.Close()
	}
	return nil
}
