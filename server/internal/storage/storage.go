// SPDX-License-Identifier: Apache-2.0

// Package storage keeps files in an S3-compatible object store (Garage by
// default; any S3 service works). Browsers upload directly with a POST policy
// that fixes the key and the exact size; the server reads objects back to
// serve them with its own access checks and headers.
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ErrNotFound: no object under the key.
var ErrNotFound = errors.New("storage: object not found")

// Config describes the object store.
type Config struct {
	// Endpoint is the S3 API the server talks to, e.g. http://garage:3900.
	Endpoint  string
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
	// UploadURL is where browsers send uploads (POST); default: the endpoint
	// with the bucket as path. Behind the proxy it is the app's own origin.
	UploadURL string
}

// Store is an S3 bucket.
type Store struct {
	client    *minio.Client
	bucket    string
	uploadURL string
}

// New connects to the object store (lazily: nothing is sent yet).
func New(c Config) (*Store, error) {
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("storage: endpoint must be an http(s) URL, got %q", c.Endpoint)
	}
	region := c.Region
	if region == "" {
		region = "us-east-1"
	}
	client, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(c.AccessKey, c.SecretKey, ""),
		Secure: u.Scheme == "https",
		// A fixed region avoids a lookup request before every signature.
		Region:       region,
		BucketLookup: minio.BucketLookupPath,
	})
	if err != nil {
		return nil, fmt.Errorf("storage: %w", err)
	}
	upload := c.UploadURL
	if upload == "" {
		upload = strings.TrimSuffix(c.Endpoint, "/") + "/" + c.Bucket + "/"
	}
	return &Store{client: client, bucket: c.Bucket, uploadURL: upload}, nil
}

// Upload is a form a browser posts to store one object.
type Upload struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

// UploadForm allows one upload of exactly size bytes under key until expiry.
func (s *Store) UploadForm(ctx context.Context, key string, size int64, valid time.Duration) (Upload, error) {
	p := minio.NewPostPolicy()
	for _, err := range []error{
		p.SetBucket(s.bucket), p.SetKey(key), p.SetExpires(time.Now().UTC().Add(valid)),
		p.SetContentLengthRange(size, size),
	} {
		if err != nil {
			return Upload{}, err
		}
	}
	_, fields, err := s.client.PresignedPostPolicy(ctx, p)
	if err != nil {
		return Upload{}, err
	}
	return Upload{URL: s.uploadURL, Fields: fields}, nil
}

// Size returns the size of an object.
func (s *Store) Size(ctx context.Context, key string) (int64, error) {
	info, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return 0, notFound(err)
	}
	return info.Size, nil
}

// Object is a stored object opened for reading; it can seek (ranges).
type Object interface {
	io.ReadSeekCloser
	io.ReaderAt
}

// Open returns an object for reading.
func (s *Store) Open(ctx context.Context, key string) (Object, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, notFound(err)
	}
	// GetObject is lazy: Stat makes a missing object an error now.
	if _, err := obj.Stat(); err != nil {
		_ = obj.Close()
		return nil, notFound(err)
	}
	return obj, nil
}

// Put stores an object the server made (thumbnails).
func (s *Store) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{ContentType: contentType})
	return err
}

// Remove deletes an object; a missing one is not an error.
func (s *Store) Remove(ctx context.Context, key string) error {
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

// Check implements health.Checker: the bucket is reachable.
func (s *Store) Check(ctx context.Context) error {
	ok, err := s.client.BucketExists(ctx, s.bucket)
	if err == nil && !ok {
		err = fmt.Errorf("storage: bucket %q does not exist", s.bucket)
	}
	return err
}

// Name implements health.Checker.
func (s *Store) Name() string { return "storage" }

func notFound(err error) error {
	if minio.ToErrorResponse(err).StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	return err
}
