package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"strings"
	"sync/atomic"
	"testing"
)

func gzipImportBytes(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(raw); err != nil {
		t.Fatal("failed to encode synthetic gzip fixture")
	}
	if err := writer.Close(); err != nil {
		t.Fatal("failed to finalize synthetic gzip fixture")
	}
	return bytes.Clone(buffer.Bytes())
}

func uploadGzipImport(t *testing.T, server *Server, compressed []byte, originalSize int64) HARImportView {
	t.Helper()
	input := fmt.Sprintf(`{"size":%d,"encoding":"gzip","originalSize":%d}`, len(compressed), originalSize)
	w := importHTTPRequest(server, "POST", "/api/har/imports", strings.NewReader(input), "application/json")
	var view HARImportView
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &view) != nil || view.Encoding != "gzip" || view.OriginalSize != originalSize || view.Size != int64(len(compressed)) {
		t.Fatalf("gzip import did not preserve normalized transfer metadata: status=%d", w.Code)
	}
	for offset := 0; offset < len(compressed); offset += int(harImportChunkSize) {
		end := min(offset+int(harImportChunkSize), len(compressed))
		if putImportChunk(server, view.ID, offset, compressed[offset:end]).Code != 200 {
			t.Fatal("gzip transfer chunk failed")
		}
	}
	return view
}

func TestHARImportGzipRoundTripPreservesFullOriginalAcrossChunks(t *testing.T) {
	server := newImportTestServer(t)
	noise := make([]byte, 2<<20)
	_, _ = rand.New(rand.NewSource(17)).Read(noise)
	originalBody := "无损还原：" + base64.StdEncoding.EncodeToString(noise)
	raw := syntheticImportHAR(originalBody)
	compressed := gzipImportBytes(t, raw)
	if len(compressed) <= int(harImportChunkSize) {
		t.Fatal("roundtrip fixture must exercise multiple compressed chunks")
	}
	var calls atomic.Int32
	server.imports.parse = func(decoded json.RawMessage) (ParseResult, error) {
		calls.Add(1)
		if !bytes.Equal(decoded, raw) {
			t.Error("gzip changed the original HAR bytes")
		}
		return ParseHAR(decoded)
	}
	view := uploadGzipImport(t, server, compressed, int64(len(raw)))
	if importAction(server, "POST", view.ID, "complete").Code != 202 {
		t.Fatal("gzip complete was not asynchronous")
	}
	finished := waitImport(t, server, view.ID, "completed")
	server.imports.workers.Wait()
	if finished.ReceivedBytes != int64(len(compressed)) || finished.OriginalSize != int64(len(raw)) || calls.Load() != 1 || len(server.uploadSlots) != 0 {
		t.Fatal("gzip import lost byte accounting, duplicated parse, or leaked its slot")
	}
	result := importAction(server, "GET", view.ID, "result")
	var parsed ParseResult
	if result.Code != 200 || json.Unmarshal(result.Body.Bytes(), &parsed) != nil || len(parsed.Requests) != 1 {
		t.Fatal("gzip result unavailable")
	}
	request := parsed.Requests[0]
	if request.Headers["Cookie"] != "synthetic-original-cookie" || request.Body != "synthetic-original-body" || !request.ResponseBodyTruncated {
		t.Fatal("gzip altered original request fields or preview behavior")
	}
	detail := importHTTPRequest(server, "GET", request.ResponseDetailURL, nil, "")
	var full struct{ Request Request }
	if detail.Code != 200 || json.Unmarshal(detail.Body.Bytes(), &full) != nil || full.Request.ResponseBody != originalBody {
		t.Fatal("gzip import lost the complete captured response")
	}
}

func TestHARImportGzipRejectsCorruptionTrailingDataAndSizeMismatch(t *testing.T) {
	raw := syntheticImportHAR("synthetic private response")
	valid := gzipImportBytes(t, raw)
	badCRC := bytes.Clone(valid)
	badCRC[len(badCRC)-8] ^= 1
	cases := []struct {
		name     string
		data     []byte
		declared int64
		code     string
	}{
		{"invalid header", []byte("synthetic-private-invalid-gzip"), int64(len(raw)), "invalid_gzip"},
		{"truncated member", valid[:len(valid)-5], int64(len(raw)), "invalid_gzip"},
		{"CRC corruption", badCRC, int64(len(raw)), "invalid_gzip"},
		{"trailing bytes", append(bytes.Clone(valid), []byte("synthetic-private-trailing-data")...), int64(len(raw)), "gzip_trailing_data"},
		{"second gzip member", append(bytes.Clone(valid), valid...), int64(len(raw)), "gzip_trailing_data"},
		{"declared too short", valid, int64(len(raw) - 1), "gzip_size_mismatch"},
		{"declared too long", valid, int64(len(raw) + 1), "gzip_size_mismatch"},
		{"expansion exceeds declaration", gzipImportBytes(t, bytes.Repeat([]byte("x"), 8<<20)), 1024, "gzip_size_mismatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := newImportTestServer(t)
			var calls atomic.Int32
			server.imports.parse = func(json.RawMessage) (ParseResult, error) {
				calls.Add(1)
				t.Error("invalid gzip reached HAR parsing")
				return ParseResult{}, nil
			}
			view := uploadGzipImport(t, server, tc.data, tc.declared)
			if importAction(server, "POST", view.ID, "complete").Code != 202 {
				t.Fatal("complete failed to start validation")
			}
			failed := waitImport(t, server, view.ID, "failed")
			server.imports.workers.Wait()
			if failed.ErrorCode != tc.code || failed.Error == "" || strings.Contains(failed.Error, "synthetic-private") || calls.Load() != 0 || len(server.uploadSlots) != 0 || importAction(server, "GET", view.ID, "result").Code != 409 {
				t.Fatal("gzip error was misclassified, leaked content, or published partial results")
			}
			server.uploads.mu.Lock()
			retained := len(server.uploads.items)
			server.uploads.mu.Unlock()
			if retained != 0 {
				t.Fatal("rejected gzip retained a partial capture")
			}
		})
	}
}

func TestHARImportEncodingAdmissionNormalizesLegacyAndRejectsInvalidDeclarations(t *testing.T) {
	server := newImportTestServer(t)
	legacy := createImport(t, server, 1)
	if legacy.Encoding != "identity" || legacy.OriginalSize != legacy.Size {
		t.Fatal("legacy size-only create did not normalize identity metadata")
	}
	importAction(server, "DELETE", legacy.ID, "")
	for _, input := range []string{
		`{"size":20,"encoding":"br","originalSize":20}`,
		`{"size":20,"encoding":"gzip"}`,
		`{"size":20,"encoding":"gzip","originalSize":0}`,
		`{"size":20,"encoding":"gzip","originalSize":-1}`,
		`{"size":20,"encoding":"gzip","originalSize":268435457}`,
		`{"size":268435457,"encoding":"gzip","originalSize":20}`,
		`{"size":20,"encoding":"identity","originalSize":21}`,
		`{"size":20,"originalSize":19}`,
	} {
		if response := importHTTPRequest(server, "POST", "/api/har/imports", strings.NewReader(input), "application/json"); response.Code != 400 {
			t.Fatal("invalid compression declaration bypassed admission checks")
		}
		if len(server.uploadSlots) != 0 {
			t.Fatal("invalid compression declaration retained an import slot")
		}
	}
}

type cancellingDecodedReader struct {
	cancel context.CancelFunc
	reads  int
}

func (r *cancellingDecodedReader) Read(p []byte) (int, error) {
	r.reads++
	r.cancel()
	return copy(p, "synthetic private output"), nil
}

func TestHARImportDecodedReadBoundCapsCapacityAndChecksCancellation(t *testing.T) {
	for _, declared := range []int64{1, 31, 32 << 10, (64 << 10) + 3} {
		decoded, err := readBoundedHAR(context.Background(), bytes.NewReader(bytes.Repeat([]byte("x"), 1<<20)), declared)
		if err != nil || int64(len(decoded)) != declared+1 || int64(cap(decoded)) > declared+1 {
			t.Fatal("bounded decoded read allocated or consumed past its one-byte detection bound")
		}
	}
	if output, err := readBoundedHAR(context.Background(), strings.NewReader("unused"), sampleFileLimit+1); err == nil || len(output) != 0 {
		t.Fatal("oversized decoded allocation bound was accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancellingDecodedReader{cancel: cancel}
	if _, err := readBoundedHAR(ctx, reader, 1024); err != context.Canceled || reader.reads != 1 {
		t.Fatal("cancelled decoder continued reading or allocating output")
	}
	if output, failure := decodeGzipHAR(ctx, []byte("unread"), 1024); failure == nil || failure.code != "upload_cancelled" || len(output) != 0 {
		t.Fatal("cancelled gzip worker began decoding")
	}
}

func TestHARImportGzipCancellationRetainsWorkerSlotAndNeverCommitsLate(t *testing.T) {
	server := newImportTestServer(t)
	raw := syntheticImportHAR("synthetic response")
	compressed := gzipImportBytes(t, raw)
	entered, release := make(chan struct{}), make(chan struct{})
	server.imports.parse = func(decoded json.RawMessage) (ParseResult, error) {
		if !bytes.Equal(decoded, raw) {
			t.Error("parser received compressed or modified bytes")
		}
		close(entered)
		<-release
		return ParseHAR(decoded)
	}
	defer close(release)
	view := uploadGzipImport(t, server, compressed, int64(len(raw)))
	second := createImport(t, server, 1)
	importAction(server, "POST", view.ID, "complete")
	<-entered
	importAction(server, "DELETE", view.ID, "")
	waitImport(t, server, view.ID, "cancelled")
	if len(server.uploadSlots) != 2 {
		t.Fatal("gzip parser cancellation released capacity before the worker exited")
	}
	release <- struct{}{}
	server.imports.workers.Wait()
	if len(server.uploadSlots) != 1 || importAction(server, "GET", view.ID, "result").Code != 409 {
		t.Fatal("cancelled gzip parser retained a slot or published a late result")
	}
	server.uploads.mu.Lock()
	count := len(server.uploads.items)
	server.uploads.mu.Unlock()
	if count != 0 {
		t.Fatal("cancelled gzip worker committed capture data")
	}
	importAction(server, "DELETE", second.ID, "")
}

func TestHARImportGzipLogsOnlyFixedStagesAndByteCounts(t *testing.T) {
	server := newImportTestServer(t)
	raw := syntheticImportHAR("synthetic-private-HAR-content")
	compressed := gzipImportBytes(t, raw)
	var logs bytes.Buffer
	previousOutput := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(previousOutput)
	view := uploadGzipImport(t, server, compressed, int64(len(raw)))
	importAction(server, "POST", view.ID, "complete")
	waitImport(t, server, view.ID, "completed")
	server.imports.workers.Wait()
	text := logs.String()
	if !strings.Contains(text, "stage=decode_start encoding=gzip") || !strings.Contains(text, "stage=decode_done encoding=gzip") || !strings.Contains(text, fmt.Sprintf("input_bytes=%d output_bytes=%d", len(compressed), len(raw))) {
		t.Fatal("gzip logs lost decode-stage byte accounting")
	}
	if strings.Contains(text, "synthetic-private") || strings.Contains(text, "synthetic.invalid") || strings.Contains(text, "Cookie") || strings.Contains(text, io.ErrUnexpectedEOF.Error()) {
		t.Fatal("gzip logs leaked HAR data or raw errors")
	}
}
