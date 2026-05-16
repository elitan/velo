package proxy

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"time"
)

type Config struct {
	APIURL          string
	Token           string
	BindAddress     string
	RefreshInterval time.Duration
	IdleTimeout     time.Duration
	Logger          *log.Logger
}

type Server struct {
	config    Config
	client    *APIClient
	logger    *log.Logger
	mu        sync.Mutex
	branches  map[int]Branch
	ports     map[int]int
	listeners map[int]net.Listener
	active    map[int]int
	lastSeen  map[int]time.Time
	wakeLocks map[int]*sync.Mutex
	stopping  map[int]bool
}

func NewServer(config Config) *Server {
	if config.RefreshInterval <= 0 {
		config.RefreshInterval = 2 * time.Second
	}
	if config.BindAddress == "" {
		config.BindAddress = "127.0.0.1"
	}
	if config.Logger == nil {
		config.Logger = log.Default()
	}

	return &Server{
		config:    config,
		client:    NewAPIClient(config.APIURL, config.Token),
		logger:    config.Logger,
		branches:  map[int]Branch{},
		ports:     map[int]int{},
		listeners: map[int]net.Listener{},
		active:    map[int]int{},
		lastSeen:  map[int]time.Time{},
		wakeLocks: map[int]*sync.Mutex{},
		stopping:  map[int]bool{},
	}
}

func (server *Server) Run(ctx context.Context) error {
	if err := server.refresh(ctx); err != nil {
		server.logger.Printf("initial refresh failed: %v", err)
	}

	refreshTicker := time.NewTicker(server.config.RefreshInterval)
	defer refreshTicker.Stop()

	idleTicker := time.NewTicker(server.idleCheckInterval())
	defer idleTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			server.closeListeners()
			return nil
		case <-refreshTicker.C:
			if err := server.refresh(ctx); err != nil {
				server.logger.Printf("refresh failed: %v", err)
			}
		case <-idleTicker.C:
			server.checkIdleBranches(ctx)
		}
	}
}

func (server *Server) refresh(ctx context.Context) error {
	branches, err := server.client.ListBranches(ctx)
	if err != nil {
		return err
	}

	nextPorts := map[int]bool{}

	server.mu.Lock()
	for _, branch := range branches {
		server.branches[branch.ID] = branch
		server.ports[branch.ProxyPort] = branch.ID
		nextPorts[branch.ProxyPort] = true

		if _, ok := server.lastSeen[branch.ID]; !ok {
			server.lastSeen[branch.ID] = parseBranchTime(branch.LastActiveAt)
		}
		if _, ok := server.wakeLocks[branch.ID]; !ok {
			server.wakeLocks[branch.ID] = &sync.Mutex{}
		}
	}

	for port, listener := range server.listeners {
		if !nextPorts[port] {
			_ = listener.Close()
			delete(server.listeners, port)
			delete(server.ports, port)
		}
	}

	var listenPorts []int
	for _, branch := range branches {
		if _, ok := server.listeners[branch.ProxyPort]; !ok {
			listenPorts = append(listenPorts, branch.ProxyPort)
		}
	}
	server.mu.Unlock()

	for _, port := range listenPorts {
		if err := server.startListener(port); err != nil {
			server.logger.Printf("listen %d failed: %v", port, err)
		}
	}

	return nil
}

func (server *Server) startListener(port int) error {
	address := fmt.Sprintf("%s:%d", server.config.BindAddress, port)
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}

	server.mu.Lock()
	server.listeners[port] = listener
	server.mu.Unlock()

	server.logger.Printf("listening on %s", address)

	go server.acceptLoop(port, listener)
	return nil
}

func (server *Server) acceptLoop(port int, listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}

		go server.handleConnection(port, conn)
	}
}

func (server *Server) handleConnection(port int, clientConn net.Conn) {
	branch, ok := server.branchByPort(port)
	if !ok {
		_ = clientConn.Close()
		return
	}

	server.markActive(branch.ID)
	defer server.markInactive(branch.ID)
	defer clientConn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	if err := server.client.TouchBranch(ctx, branch.ID); err != nil {
		server.logger.Printf("touch branch %s failed: %v", branch.Slug, err)
	}

	backendPort := branch.BackendPort
	dialTimeout := 2 * time.Second
	if branch.Status == "stopped" {
		startedPort, err := server.startBranch(ctx, branch, false)
		if err != nil {
			server.logger.Printf("start branch %s failed: %v", branch.Slug, err)
			return
		}
		backendPort = startedPort
		dialTimeout = 30 * time.Second
	}

	backendConn, err := dialBackend(backendPort, dialTimeout)
	if err != nil {
		startedPort, startErr := server.startBranch(ctx, branch, true)
		if startErr != nil {
			server.logger.Printf("start branch %s after dial failure failed: %v", branch.Slug, startErr)
			return
		}

		backendConn, err = dialBackend(startedPort, 30*time.Second)
		if err != nil {
			server.logger.Printf("dial branch %s backend failed: %v", branch.Slug, err)
			return
		}
	}
	defer backendConn.Close()

	copyBoth(clientConn, backendConn)
}

func (server *Server) startBranch(ctx context.Context, branch Branch, force bool) (int, error) {
	lock := server.branchLock(branch.ID)
	lock.Lock()
	defer lock.Unlock()

	current, ok := server.branchByID(branch.ID)
	if !force && ok && current.Status != "stopped" {
		return current.BackendPort, nil
	}

	backendPort, err := server.client.StartBranch(ctx, branch.ID)
	if err != nil {
		return 0, err
	}

	server.mu.Lock()
	branch.Status = "running"
	branch.BackendPort = backendPort
	server.branches[branch.ID] = branch
	server.mu.Unlock()

	return backendPort, nil
}

func (server *Server) checkIdleBranches(ctx context.Context) {
	if server.config.IdleTimeout <= 0 {
		return
	}

	now := time.Now()
	var targets []Branch

	server.mu.Lock()
	for _, branch := range server.branches {
		if branch.Status != "running" || server.active[branch.ID] > 0 || server.stopping[branch.ID] {
			continue
		}

		lastSeen := server.lastSeen[branch.ID]
		if lastSeen.IsZero() {
			lastSeen = parseBranchTime(branch.LastActiveAt)
		}
		if lastSeen.IsZero() || now.Sub(lastSeen) < server.config.IdleTimeout {
			continue
		}

		server.stopping[branch.ID] = true
		targets = append(targets, branch)
	}
	server.mu.Unlock()

	for _, branch := range targets {
		go server.stopBranch(ctx, branch)
	}
}

func (server *Server) stopBranch(ctx context.Context, branch Branch) {
	stopCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	err := server.client.StopBranch(stopCtx, branch.ID)

	server.mu.Lock()
	defer server.mu.Unlock()
	delete(server.stopping, branch.ID)

	if err != nil {
		server.logger.Printf("stop branch %s failed: %v", branch.Slug, err)
		return
	}

	branch.Status = "stopped"
	server.branches[branch.ID] = branch
	server.logger.Printf("stopped idle branch %s", branch.Slug)
}

func (server *Server) branchByPort(port int) (Branch, bool) {
	server.mu.Lock()
	defer server.mu.Unlock()

	branchID, ok := server.ports[port]
	if !ok {
		return Branch{}, false
	}

	branch, ok := server.branches[branchID]
	return branch, ok
}

func (server *Server) branchByID(branchID int) (Branch, bool) {
	server.mu.Lock()
	defer server.mu.Unlock()

	branch, ok := server.branches[branchID]
	return branch, ok
}

func (server *Server) branchLock(branchID int) *sync.Mutex {
	server.mu.Lock()
	defer server.mu.Unlock()

	lock, ok := server.wakeLocks[branchID]
	if !ok {
		lock = &sync.Mutex{}
		server.wakeLocks[branchID] = lock
	}

	return lock
}

func (server *Server) markActive(branchID int) {
	server.mu.Lock()
	defer server.mu.Unlock()

	server.active[branchID]++
	server.lastSeen[branchID] = time.Now()
}

func (server *Server) markInactive(branchID int) {
	server.mu.Lock()
	defer server.mu.Unlock()

	if server.active[branchID] > 0 {
		server.active[branchID]--
	}
	server.lastSeen[branchID] = time.Now()
}

func (server *Server) closeListeners() {
	server.mu.Lock()
	defer server.mu.Unlock()

	for port, listener := range server.listeners {
		_ = listener.Close()
		delete(server.listeners, port)
	}
}

func (server *Server) idleCheckInterval() time.Duration {
	if server.config.IdleTimeout > 0 && server.config.IdleTimeout < 10*time.Second {
		return server.config.IdleTimeout / 2
	}

	return 10 * time.Second
}

func dialBackend(port int, timeout time.Duration) (net.Conn, error) {
	deadline := time.Now().Add(timeout)
	address := fmt.Sprintf("127.0.0.1:%d", port)
	var lastErr error

	for {
		conn, err := net.DialTimeout("tcp", address, time.Second)
		if err == nil {
			return conn, nil
		}

		lastErr = err
		if time.Now().After(deadline) {
			return nil, lastErr
		}

		time.Sleep(250 * time.Millisecond)
	}
}

func parseBranchTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}

	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}

	return parsed
}

func copyBoth(first net.Conn, second net.Conn) {
	done := make(chan struct{}, 2)

	go func() {
		_, _ = io.Copy(first, second)
		done <- struct{}{}
	}()

	go func() {
		_, _ = io.Copy(second, first)
		done <- struct{}{}
	}()

	<-done
	_ = first.Close()
	_ = second.Close()
	<-done
}
