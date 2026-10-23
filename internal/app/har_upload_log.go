package app

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"time"
)

type harFailure struct {
	status  int
	code    string
	message string
}

func harReadFailure(ctx context.Context, err error) harFailure {
	var tooLarge *http.MaxBytesError
	var timeout net.Error
	switch {
	case errors.As(err, &tooLarge):
		return harFailure{413, "upload_too_large", "上传内容超过大小限制，请缩小文件或分片后重试。"}
	case errors.Is(ctx.Err(), context.Canceled), errors.Is(err, context.Canceled):
		return harFailure{400, "upload_cancelled", "上传已中断，请重新上传文件。"}
	case errors.Is(ctx.Err(), context.DeadlineExceeded), errors.Is(err, context.DeadlineExceeded), errors.As(err, &timeout) && timeout.Timeout():
		return harFailure{408, "upload_timeout", "上传读取超时，请检查网络后重试。"}
	case errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, io.EOF):
		return harFailure{400, "upload_incomplete", "上传未完成，连接提前断开；请重新上传文件。"}
	default:
		return harFailure{400, "upload_read_failed", "读取上传内容失败，请检查网络后重试。"}
	}
}

func writeHARFailure(w http.ResponseWriter, failure harFailure) {
	writeJSON(w, failure.status, map[string]string{"error": failure.message, "errorCode": failure.code})
}

// Fixed stages/codes and numeric metadata only: never log err.Error(), a file
// name, multipart headers, URL, or captured request/response content.
func logHARStage(requestID, importID, stage, code string, started time.Time, received, expected int64) {
	if requestID == "" {
		requestID = "-"
	}
	if importID == "" {
		importID = "-"
	}
	if code == "" {
		code = "none"
	}
	log.Printf("har_import request_id=%s import_id=%s stage=%s error_code=%s received_bytes=%d expected_bytes=%d duration_ms=%d", requestID, importID, stage, code, received, expected, time.Since(started).Milliseconds())
}
