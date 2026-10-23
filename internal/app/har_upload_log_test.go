package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

type syntheticUploadTimeout struct{}

func (syntheticUploadTimeout) Error() string   { return "synthetic-private-network-detail" }
func (syntheticUploadTimeout) Timeout() bool   { return true }
func (syntheticUploadTimeout) Temporary() bool { return false }

func TestHARReadErrorClassificationNeverCopiesRawErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tc := range []struct {
		ctx    context.Context
		err    error
		status int
		code   string
	}{
		{context.Background(), io.ErrUnexpectedEOF, 400, "upload_incomplete"},
		{ctx, errors.New("synthetic-private-network-detail"), 400, "upload_cancelled"},
		{context.Background(), syntheticUploadTimeout{}, 408, "upload_timeout"},
		{context.Background(), &http.MaxBytesError{Limit: 1}, 413, "upload_too_large"},
		{context.Background(), errors.New("synthetic-private-network-detail"), 400, "upload_read_failed"},
	} {
		failure := harReadFailure(tc.ctx, tc.err)
		if failure.status != tc.status || failure.code != tc.code || strings.Contains(failure.message, "synthetic-private") {
			t.Fatal("read failure classification lost its controlled status/message")
		}
	}
}

func TestLegacyHARUploadLogsReadingStageAndNoPrivateData(t *testing.T) {
	server := newImportTestServer(t)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "synthetic-private-filename.har")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(part, strings.Repeat("synthetic-private-HAR-content", 100))
	_ = writer.Close()
	var logs bytes.Buffer
	previousOutput := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(previousOutput)
	broken := &interruptedImportBody{data: bytes.Clone(body.Bytes()[:body.Len()/2])}
	w := importHTTPRequest(server, "POST", "/api/har/upload", broken, writer.FormDataContentType())
	var response map[string]string
	if w.Code != 400 || json.Unmarshal(w.Body.Bytes(), &response) != nil || response["errorCode"] != "upload_incomplete" {
		t.Fatal("legacy truncated upload did not return the classified failure")
	}
	text := logs.String()
	if !strings.Contains(text, "stage=read_file_failed") || !strings.Contains(text, "error_code=upload_incomplete") || !strings.Contains(text, "received_bytes=") || strings.Contains(text, "stage=parse_start") {
		t.Fatal("legacy diagnostics failed to distinguish reading from parsing")
	}
	if strings.Contains(text, "synthetic-private") || strings.Contains(text, "unexpected EOF") {
		t.Fatal("legacy stage logs exposed a filename, HAR content, or raw error")
	}
}
