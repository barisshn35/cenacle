# 0015. Files in an S3-compatible object store (v0.12)

- Status: accepted
- Date: 2026-10-22

## Context

People share images, documents and other files in channels. The bytes must not live in
PostgreSQL, the stack must stay self-hosted and optional parts must stay optional, and a
file served from the app's own origin must never act as a page of the app.

## Decisions

1. **Object store: S3 API, Garage by default.** The server talks S3 only (`minio-go`,
   Apache-2.0, as a client library; no MinIO server). The compose stack runs Garage v2
   (AGPL-3.0, its own container, single-node mode with one bucket and key created at
   start, SQLite metadata, non-root, read-only root). Any S3 service can replace it
   (`CENACLE_S3_*`). Without an endpoint, files are off: uploads answer 503
   `files_disabled` and the session says `upload_files: false`.
2. **Uploads go straight from the browser to the store** with an S3 POST policy the server
   signs per file: a fixed key (`files/<id>`), the exact size and 15 minutes. Caddy passes
   only `POST /<bucket>/` from the chat domain to Garage, so no S3 endpoint is exposed and no
   CORS is needed. The server never buffers uploads.
3. **Complete is synchronous.** `POST /api/files/{id}/complete` checks the stored size, scans
   the file when `CENACLE_CLAMAV_ADDR` names a clamd (ClamAV runs as its own service; a hit
   deletes the bytes and marks the file `blocked`), recognizes images by their content (not
   by the name or the declared type: a "PNG" that is a page becomes
   `application/octet-stream`), and makes a preview (≤ 480 px, JPEG or PNG, EXIF
   orientation applied, metadata dropped; images over 50 megapixels or 40 MB keep no
   preview). Decoding runs at most four at a time. One completion at a time checks a file:
   it claims the upload (for ten minutes) before moving the bytes to the file's key, and
   only that claim records the verdict, so a verdict always belongs to the bytes served;
   a second completion meanwhile gets 409 `upload_incomplete` (later, the verdict).
4. **Downloads go through the server**, which checks that the reader is a member of the
   channel and that the message is not deleted (unsent uploads: only the uploader). Files
   are served from the app's origin with `Content-Security-Policy: sandbox`, `nosniff`, a
   `Content-Disposition` filename, and inline display only for raster images, audio, video
   and PDF; everything else is an attachment of type `application/octet-stream`. Ranges
   work (video seeking). Responses are privately cacheable (files never change).
5. **Messages carry up to ten files** (`file_ids`), the sender's own ready uploads into that
   channel, attached in the message's transaction; a message may consist of files only.
   Events and pages include `files`. Bots with `messages:write` can upload the same way.
6. **Lifecycle.** Uploads never sent within a day and files of purged messages (after the
   restore window of deleted messages) are removed, bytes first, by an hourly job.
7. **Viewer.** Images open in a viewer (keyboard navigation, explicit download); the
   channel's files are listed in its details panel. View-only files and watermarks belong
   to the compliance release (v0.23), where a policy decides them.

## Consequences

- Upgrades must run `gen-secrets.sh` again (Garage's secrets) and pull the new proxy image.
- An external S3 service needs `CENACLE_S3_UPLOAD_URL` and a CORS rule for `POST` from the
  app's origin.
- The bucket joins the backups.
