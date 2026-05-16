package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestProxyWakesStoppedBranchAndForwardsTraffic(t *testing.T) {
	backendPort := startEchoBackend(t)
	proxyPort := freePort(t)
	state := &fakeState{
		branch: Branch{
			ID:           7,
			Slug:         "dev",
			Status:       "stopped",
			ProxyPort:    proxyPort,
			BackendPort:  backendPort,
			LastActiveAt: time.Now().Add(-time.Hour).Format(time.RFC3339Nano),
		},
	}
	api := startFakeAPI(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	server := NewServer(Config{
		APIURL:          api.URL + "/internal",
		Token:           "test-token",
		BindAddress:     "127.0.0.1",
		RefreshInterval: 20 * time.Millisecond,
		IdleTimeout:     0,
		Logger:          log.New(io.Discard, "", 0),
	})
	go func() {
		_ = server.Run(ctx)
	}()

	waitForDial(t, proxyPort)
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", proxyPort))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}

	buffer := make([]byte, 5)
	if _, err := io.ReadFull(conn, buffer); err != nil {
		t.Fatal(err)
	}

	if string(buffer) != "hello" {
		t.Fatalf("expected echo, got %q", string(buffer))
	}
	if state.startCount == 0 {
		t.Fatal("expected proxy to start stopped branch")
	}
	if state.touchCount == 0 {
		t.Fatal("expected proxy to touch branch activity")
	}
}

func TestProxyRetriesStartWhenRunningBackendIsStale(t *testing.T) {
	staleBackendPort := freePort(t)
	nextBackendPort := startEchoBackend(t)
	proxyPort := freePort(t)
	state := &fakeState{
		branch: Branch{
			ID:           9,
			Slug:         "stale",
			Status:       "running",
			ProxyPort:    proxyPort,
			BackendPort:  staleBackendPort,
			LastActiveAt: time.Now().Format(time.RFC3339Nano),
		},
		startBackendPort: nextBackendPort,
	}
	api := startFakeAPI(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	server := NewServer(Config{
		APIURL:          api.URL + "/internal",
		Token:           "test-token",
		BindAddress:     "127.0.0.1",
		RefreshInterval: 20 * time.Millisecond,
		IdleTimeout:     0,
		Logger:          log.New(io.Discard, "", 0),
	})
	go func() {
		_ = server.Run(ctx)
	}()

	waitForDial(t, proxyPort)
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", proxyPort))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}

	buffer := make([]byte, 5)
	if _, err := io.ReadFull(conn, buffer); err != nil {
		t.Fatal(err)
	}

	if string(buffer) != "hello" {
		t.Fatalf("expected echo, got %q", string(buffer))
	}
	if state.startCount == 0 {
		t.Fatal("expected proxy to start branch after stale backend dial failure")
	}
	if state.branch.BackendPort != nextBackendPort {
		t.Fatalf("expected backend port %d, got %d", nextBackendPort, state.branch.BackendPort)
	}
}

func TestProxyStopsIdleBranch(t *testing.T) {
	proxyPort := freePort(t)
	state := &fakeState{
		branch: Branch{
			ID:           8,
			Slug:         "idle",
			Status:       "running",
			ProxyPort:    proxyPort,
			BackendPort:  freePort(t),
			LastActiveAt: time.Now().Add(-time.Hour).Format(time.RFC3339Nano),
		},
	}
	api := startFakeAPI(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	server := NewServer(Config{
		APIURL:          api.URL + "/internal",
		Token:           "test-token",
		BindAddress:     "127.0.0.1",
		RefreshInterval: 20 * time.Millisecond,
		IdleTimeout:     20 * time.Millisecond,
		Logger:          log.New(io.Discard, "", 0),
	})
	go func() {
		_ = server.Run(ctx)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if state.stopCount > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}

	t.Fatal("expected proxy to stop idle branch")
}

func TestProxyDoesNotStopActiveBranch(t *testing.T) {
	backendPort := startBlockingBackend(t)
	proxyPort := freePort(t)
	state := &fakeState{
		branch: Branch{
			ID:           10,
			Slug:         "active",
			Status:       "running",
			ProxyPort:    proxyPort,
			BackendPort:  backendPort,
			LastActiveAt: time.Now().Format(time.RFC3339Nano),
		},
	}
	api := startFakeAPI(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	server := NewServer(Config{
		APIURL:          api.URL + "/internal",
		Token:           "test-token",
		BindAddress:     "127.0.0.1",
		RefreshInterval: 20 * time.Millisecond,
		IdleTimeout:     50 * time.Millisecond,
		Logger:          log.New(io.Discard, "", 0),
	})
	go func() {
		_ = server.Run(ctx)
	}()

	waitForDial(t, proxyPort)
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", proxyPort))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte("keepalive")); err != nil {
		t.Fatal(err)
	}

	time.Sleep(200 * time.Millisecond)

	if state.stopCount != 0 {
		t.Fatalf("expected active branch not to stop, stopped %d times", state.stopCount)
	}
}

type fakeState struct {
	mu               sync.Mutex
	branch           Branch
	startBackendPort int
	startCount       int
	stopCount        int
	touchCount       int
}

func startFakeAPI(t *testing.T, state *fakeState) *httptest.Server {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		state.mu.Lock()
		defer state.mu.Unlock()

		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/internal/proxy/branches":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"branches": []Branch{state.branch},
			})
		case r.Method == http.MethodPost && r.URL.Path == fmt.Sprintf("/internal/branches/%d/start", state.branch.ID):
			state.startCount++
			state.branch.Status = "running"
			if state.startBackendPort != 0 {
				state.branch.BackendPort = state.startBackendPort
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          state.branch.ID,
				"backendPort": state.branch.BackendPort,
			})
		case r.Method == http.MethodPost && r.URL.Path == fmt.Sprintf("/internal/branches/%d/stop", state.branch.ID):
			state.stopCount++
			state.branch.Status = "stopped"
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      state.branch.ID,
				"stopped": true,
			})
		case r.Method == http.MethodPost && r.URL.Path == fmt.Sprintf("/internal/branches/%d/touch", state.branch.ID):
			state.touchCount++
			state.branch.LastActiveAt = time.Now().Format(time.RFC3339Nano)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      state.branch.ID,
				"touched": true,
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func startEchoBackend(t *testing.T) int {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
	})

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	return listener.Addr().(*net.TCPAddr).Port
}

func startBlockingBackend(t *testing.T) int {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
	})

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(io.Discard, conn)
			}()
		}
	}()

	return listener.Addr().(*net.TCPAddr).Port
}

func freePort(t *testing.T) int {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	return listener.Addr().(*net.TCPAddr).Port
}

func waitForDial(t *testing.T, port int) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 20*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}

	t.Fatalf("proxy did not listen on port %d", port)
}
