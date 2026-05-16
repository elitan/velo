package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/elitan/velo/internal/proxy"
)

func main() {
	apiURL := flag.String("api", envString("VELO_INTERNAL_API_URL", "http://127.0.0.1:3000/internal"), "internal Velo API URL")
	token := flag.String("token", envString("VELO_INTERNAL_TOKEN", ""), "internal API token")
	bind := flag.String("bind", envString("VELO_PROXY_BIND", "127.0.0.1"), "proxy listen address")
	refreshSeconds := flag.Int("refresh-seconds", envInt("VELO_PROXY_REFRESH_SECONDS", 2), "branch map refresh interval")
	idleSeconds := flag.Int("idle-seconds", envInt("VELO_PROXY_IDLE_SECONDS", 300), "idle stop timeout, 0 disables")
	flag.Parse()

	if *token == "" {
		log.Fatal("VELO_INTERNAL_TOKEN is required")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	server := proxy.NewServer(proxy.Config{
		APIURL:          *apiURL,
		Token:           *token,
		BindAddress:     *bind,
		RefreshInterval: time.Duration(*refreshSeconds) * time.Second,
		IdleTimeout:     time.Duration(*idleSeconds) * time.Second,
		Logger:          log.Default(),
	})

	if err := server.Run(ctx); err != nil {
		log.Fatal(err)
	}
}

func envString(name string, fallback string) string {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}

	return value
}

func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}

	var parsed int
	if _, err := fmt.Sscanf(value, "%d", &parsed); err != nil {
		return fallback
	}

	return parsed
}
