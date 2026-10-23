package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"log"
	"time"
)

// readBoundedHAR caps both decoded length and slice capacity. io.ReadAll's
// geometric growth can otherwise reserve more than the declared output bound.
// The one extra byte detects expansion beyond the declared original length.
func readBoundedHAR(ctx context.Context, reader io.Reader, originalSize int64) ([]byte, error) {
	limit := originalSize + 1
	if originalSize <= 0 || originalSize > sampleFileLimit {
		return nil, errors.New("invalid decoded size limit")
	}
	limited := io.LimitReader(reader, limit)
	result := make([]byte, 0, min(int(limit), 32<<10))
	buffer := make([]byte, min(int(limit), 32<<10))
	for {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		n, err := limited.Read(buffer)
		if n > 0 {
			needed := len(result) + n
			if needed > cap(result) {
				grown := make([]byte, len(result), min(int(limit), max(needed, cap(result)*2)))
				copy(grown, result)
				result = grown
			}
			result = append(result, buffer[:n]...)
		}
		if err == io.EOF {
			return result, nil
		}
		if err != nil {
			return result, err
		}
	}
}

func decodeGzipHAR(ctx context.Context, compressed []byte, originalSize int64) ([]byte, *harFailure) {
	if ctx.Err() != nil {
		return nil, &harFailure{400, "upload_cancelled", "导入已取消。"}
	}
	if originalSize <= 0 || originalSize > sampleFileLimit || len(compressed) > sampleFileLimit {
		return nil, &harFailure{413, "gzip_size_limit", "压缩文件或还原后的 HAR 超过大小限制。"}
	}
	input := bytes.NewReader(compressed)
	reader, err := gzip.NewReader(input)
	if err != nil {
		return nil, &harFailure{400, "invalid_gzip", "gzip 文件无效或上传不完整，请重新上传。"}
	}
	defer reader.Close()
	// bytes.Reader implements io.ByteReader, so gzip leaves the input positioned
	// exactly after one member rather than consuming trailing data into a buffer.
	reader.Multistream(false)
	decoded, err := readBoundedHAR(ctx, reader, originalSize)
	if ctx.Err() != nil {
		return decoded, &harFailure{400, "upload_cancelled", "导入已取消。"}
	}
	if int64(len(decoded)) > sampleFileLimit {
		return decoded, &harFailure{413, "gzip_size_limit", "还原后的 HAR 超过 256 MiB，请缩小抓包范围。"}
	}
	if err != nil {
		return decoded, &harFailure{400, "invalid_gzip", "gzip 校验失败或文件被截断，请重新上传。"}
	}
	if int64(len(decoded)) != originalSize {
		return decoded, &harFailure{400, "gzip_size_mismatch", "gzip 还原大小与声明的原始 HAR 大小不一致，请重新上传。"}
	}
	if input.Len() != 0 {
		return decoded, &harFailure{400, "gzip_trailing_data", "gzip 包含额外尾随数据，请重新上传单个 gzip 文件。"}
	}
	return decoded, nil
}

func logHARDecode(requestID, importID, stage, code string, started time.Time, inputBytes, outputBytes int64) {
	if requestID == "" {
		requestID = "-"
	}
	log.Printf("har_import request_id=%s import_id=%s stage=%s encoding=gzip error_code=%s input_bytes=%d output_bytes=%d duration_ms=%d", requestID, importID, stage, code, inputBytes, outputBytes, time.Since(started).Milliseconds())
}
