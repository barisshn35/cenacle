// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/extract"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// FileTextReader reads the text of new files so search finds them by what
// they say (PDF, Office, OpenDocument, plain text).
type FileTextReader struct {
	Queries *store.Queries
	Files   *Files
	Log     *slog.Logger
}

const fileTextBatch = 10

// Run implements jobs.Runner: a batch of files not read yet.
func (f *FileTextReader) Run(ctx context.Context) (int, error) {
	if f.Files == nil || f.Files.Store == nil {
		return 0, nil
	}
	rows, err := f.Queries.PendingFileTexts(ctx, fileTextBatch)
	if err != nil {
		return 0, err
	}
	done := 0
	for _, file := range rows {
		// Marked first: a file whose reading never finishes (the job's
		// timeout, a crash) is not read again and again.
		if err := f.Queries.SetFileText(ctx, store.SetFileTextParams{ID: file.ID, ContentState: "none"}); err != nil {
			return done, err
		}
		text, state := f.read(ctx, file)
		var content pgtype.Text
		if state == "done" {
			content = pgtype.Text{String: text, Valid: true}
		}
		if err := f.Queries.SetFileText(ctx, store.SetFileTextParams{ID: file.ID, ContentText: content, ContentState: state}); err != nil {
			return done, err
		}
		done++
	}
	return done, nil
}

func (f *FileTextReader) read(ctx context.Context, file store.PendingFileTextsRow) (string, string) {
	if !extract.Supported(file.ContentType, file.Name) || file.Size > extract.MaxSize {
		return "", "none"
	}
	obj, err := f.Files.Store.Open(ctx, fileKey(file.ID))
	if err != nil {
		return "", "none"
	}
	defer func() { _ = obj.Close() }()
	text, err := extract.Text(ctx, obj, file.Size, file.ContentType, file.Name)
	if err != nil || text == "" {
		if err != nil && !errors.Is(err, extract.ErrUnsupported) && f.Log != nil {
			f.Log.InfoContext(ctx, "file text not read", "file", uuid(file.ID).String(), "error", err)
		}
		return "", "none"
	}
	return text, "done"
}
