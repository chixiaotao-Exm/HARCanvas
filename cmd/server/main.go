package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"harcanvas/internal/app"
)

func main() {
	address := flag.String("addr", "127.0.0.1:8090", "HTTP listen address; use 0.0.0.0:8090 explicitly for remote access")
	web := flag.String("web", "web/dist", "Path to the built frontend directory")
	sampleHAR := flag.String("sample-har", "samples/re.har", "Optional local HAR example path; loaded once per process, never replayed automatically")
	requireAuth := flag.Bool("require-auth", false, "Refuse startup unless HAR_CANVAS_USER and HAR_CANVAS_PASSWORD are both nonempty")
	flag.Parse()
	handler := app.NewServer(*web)
	handler.SampleHAR = *sampleHAR
	protectedHandler, err := app.ConfiguredBasicAuth(handler, os.Getenv("HAR_CANVAS_USER"), os.Getenv("HAR_CANVAS_PASSWORD"), *requireAuth)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: *address, Handler: protectedHandler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 150 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	log.Printf("HAR Canvas listening on %s", *address)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
