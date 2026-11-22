package proxy_test

import (
	"bufio"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lancewilhelm/delb/internal/proxy"
)

func TestReverseProxyForwardsHTTPHeadersCookiesAndUpgrade(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			hj, ok := w.(http.Hijacker)
			if !ok {
				http.Error(w, "no hijack", http.StatusInternalServerError)
				return
			}
			conn, rw, err := hj.Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nPING-OK")
			_ = rw.Flush()
			return
		}

		w.Header().Set("X-Upstream-Host", r.Host)
		w.Header().Set("X-Upstream-Cookie", r.Header.Get("Cookie"))
		w.Header().Set("Set-Cookie", "delb.extra=1; Path=/")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("proxied:" + r.URL.Path))
	}))
	defer upstream.Close()

	p, err := proxy.New(upstream.URL, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("proxy.New: %v", err)
	}
	front := httptest.NewServer(p)
	defer front.Close()

	// 1. Standard HTTP request preserves cookies, status, response headers, and Host.
	req, _ := http.NewRequest(http.MethodGet, front.URL+"/api/books", nil)
	req.Header.Set("Cookie", "delb.session_token=abc.xyz")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /api/books: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want 201", resp.StatusCode)
	}
	if string(body) != "proxied:/api/books" {
		t.Fatalf("body = %q", string(body))
	}
	if resp.Header.Get("X-Upstream-Cookie") != "delb.session_token=abc.xyz" {
		t.Fatalf("cookie not forwarded: %q", resp.Header.Get("X-Upstream-Cookie"))
	}
	if !strings.Contains(resp.Header.Get("Set-Cookie"), "delb.extra=1") {
		t.Fatalf("Set-Cookie not returned: %q", resp.Header.Get("Set-Cookie"))
	}

	// 2. HTTP/1.1 WebSocket Upgrade forwarding (needed for Vite HMR in dev).
	conn, err := net.Dial("tcp", front.Listener.Addr().String())
	if err != nil {
		t.Fatalf("dial front: %v", err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "GET /_nuxt/ HTTP/1.1\r\nHost: localhost:3000\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
	br := bufio.NewReader(conn)
	statusLine, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read upgrade status: %v", err)
	}
	if !strings.Contains(statusLine, "101 Switching Protocols") {
		t.Fatalf("upgrade status = %q, want 101 Switching Protocols", statusLine)
	}
	// Drain headers until empty line, then read tunneled payload.
	for {
		line, err := br.ReadString('\n')
		if err != nil || line == "\r\n" {
			break
		}
	}
	payload := make([]byte, 7)
	if _, err := io.ReadFull(br, payload); err != nil {
		t.Fatalf("read tunneled bytes: %v", err)
	}
	if string(payload) != "PING-OK" {
		t.Fatalf("tunneled payload = %q, want PING-OK", string(payload))
	}
}
