// SPDX-License-Identifier: AGPL-3.0-only

package storage

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Config describes an S3-compatible object store.
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

// S3 is a bucket of an S3-compatible object store (Garage by default; any S3
// service works). Browsers upload directly with a POST policy that fixes the
// key and the exact size.
type S3 struct {
	client    *minio.Client
	bucket    string
	uploadURL string
}

// New connects to the object store (lazily: nothing is sent yet).
func New(c Config) (*S3, error) {
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
	return &S3{client: client, bucket: c.Bucket, uploadURL: upload}, nil
}

// UploadForm allows one upload of exactly size bytes under key until expiry.
func (s *S3) UploadForm(ctx context.Context, key string, size int64, valid time.Duration) (Upload, error) {
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
func (s *S3) Size(ctx context.Context, key string) (int64, error) {
	info, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return 0, notFound(err)
	}
	return info.Size, nil
}

// Open returns an object for reading.
func (s *S3) Open(ctx context.Context, key string) (Object, error) {
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
func (s *S3) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{ContentType: contentType})
	return err
}

// Promote moves an upload to its key: a copy on the server (in parts above
// the 5 GiB a single copy takes; parts must be at least 5 MiB).
func (s *S3) Promote(ctx context.Context, from, to string) error {
	info, err := s.client.StatObject(ctx, s.bucket, from, minio.StatObjectOptions{})
	if err != nil {
		return notFound(err)
	}
	dst := minio.CopyDestOptions{Bucket: s.bucket, Object: to}
	src := minio.CopySrcOptions{Bucket: s.bucket, Object: from, MatchETag: info.ETag}
	if info.Size <= 5<<30 {
		_, err = s.client.CopyObject(ctx, dst, src)
	} else {
		_, err = s.client.ComposeObject(ctx, dst, src)
	}
	if err != nil {
		return notFound(err)
	}
	return s.client.RemoveObject(ctx, s.bucket, from, minio.RemoveObjectOptions{})
}

// Remove deletes an object; a missing one is not an error.
func (s *S3) Remove(ctx context.Context, key string) error {
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

// Check implements health.Checker: the bucket is reachable.
func (s *S3) Check(ctx context.Context) error {
	ok, err := s.client.BucketExists(ctx, s.bucket)
	if err == nil && !ok {
		err = fmt.Errorf("storage: bucket %q does not exist", s.bucket)
	}
	return err
}

// Name implements health.Checker.
func (*S3) Name() string { return "storage" }

func notFound(err error) error {
	if minio.ToErrorResponse(err).StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	return err
}
