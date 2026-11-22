package books

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

const (
	externalImageTimeout      = 10 * time.Second
	externalImageMaxBytes     = 10 * 1024 * 1024
	externalImageMaxRedirects = 3
	externalImageMaxPixels    = 40_000_000
)

var (
	// Restricted public IPv4 blocks matching server/utils/books/external-image.ts.
	ipv4CGNAT    = netip.MustParsePrefix("100.64.0.0/10")
	ipv4IETFProt = netip.MustParsePrefix("192.0.0.0/24")
	ipv4TestNet1 = netip.MustParsePrefix("192.0.2.0/24")
	ipv4Relay64  = netip.MustParsePrefix("192.88.99.0/24")
	ipv4Bench    = netip.MustParsePrefix("198.18.0.0/15")
	ipv4TestNet2 = netip.MustParsePrefix("198.51.100.0/24")
	ipv4TestNet3 = netip.MustParsePrefix("203.0.113.0/24")
	ipv4Reserved = netip.MustParsePrefix("240.0.0.0/4")
	ipv4ThisNet  = netip.MustParsePrefix("0.0.0.0/8")

	// Allowed IPv6 global unicast & restricted subranges matching ipaddr.js + external-image.ts.
	ipv6GlobalUnicast = netip.MustParsePrefix("2000::/3")
	ipv6IETFSpecial   = netip.MustParsePrefix("2001::/23")
	ipv6Doc           = netip.MustParsePrefix("2001:db8::/32")
	ipv66to4          = netip.MustParsePrefix("2002::/16")
)

// IsPublicIP reports whether addr is a globally routable unicast IP address,
// mirroring server/utils/books/external-image.ts isPublicAddress.
func IsPublicIP(addr netip.Addr) bool {
	if !addr.IsValid() {
		return false
	}
	if addr.Is4In6() {
		// IPv4-mapped IPv6 addresses are treated as non-public by ipaddr.js (range 'ipv4Mapped' != 'unicast').
		return false
	}
	if addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsMulticast() || addr.IsUnspecified() ||
		addr.IsInterfaceLocalMulticast() {
		return false
	}
	if addr.Is4() {
		if ipv4ThisNet.Contains(addr) ||
			ipv4CGNAT.Contains(addr) ||
			ipv4IETFProt.Contains(addr) ||
			ipv4TestNet1.Contains(addr) ||
			ipv4Relay64.Contains(addr) ||
			ipv4Bench.Contains(addr) ||
			ipv4TestNet2.Contains(addr) ||
			ipv4TestNet3.Contains(addr) ||
			ipv4Reserved.Contains(addr) {
			return false
		}
		return true
	}
	// IPv6
	if !ipv6GlobalUnicast.Contains(addr) {
		return false
	}
	if ipv6IETFSpecial.Contains(addr) || ipv6Doc.Contains(addr) || ipv66to4.Contains(addr) {
		return false
	}
	return true
}

// ExternalImageFetcher fetches external cover images with SSRF protection and DNS pinning.
type ExternalImageFetcher struct {
	LookupIPAddr func(ctx context.Context, host string) ([]netip.Addr, error)
	DialContext  func(ctx context.Context, network, addr string) (net.Conn, error)
	Timeout      time.Duration
}

// DefaultExternalImageFetcher returns a fetcher using net.DefaultResolver and net.Dialer.
func DefaultExternalImageFetcher() *ExternalImageFetcher {
	dialer := &net.Dialer{Timeout: externalImageTimeout}
	return &ExternalImageFetcher{
		LookupIPAddr: func(ctx context.Context, host string) ([]netip.Addr, error) {
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			out := make([]netip.Addr, 0, len(ips))
			for _, ip := range ips {
				if addr, ok := netip.AddrFromSlice(ip.IP); ok {
					out = append(out, addr)
				}
			}
			return out, nil
		},
		DialContext: dialer.DialContext,
		Timeout:     externalImageTimeout,
	}
}

func parseExternalURL(input string, base *url.URL) (*url.URL, error) {
	var parsed *url.URL
	var err error
	if base != nil {
		ref, rerr := url.Parse(input)
		if rerr != nil {
			return nil, httpapi.NewError(http.StatusBadRequest, "Invalid url")
		}
		parsed = base.ResolveReference(ref)
	} else {
		parsed, err = url.Parse(input)
		if err != nil || parsed.Host == "" {
			return nil, httpapi.NewError(http.StatusBadRequest, "Invalid url")
		}
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, httpapi.NewError(http.StatusBadRequest, "Invalid url protocol")
	}
	if parsed.User != nil {
		return nil, httpapi.NewError(http.StatusBadRequest, "Invalid image URL host")
	}
	return parsed, nil
}

func (f *ExternalImageFetcher) resolvePublicAddress(ctx context.Context, u *url.URL) (netip.Addr, error) {
	host := strings.ToLower(strings.Trim(u.Hostname(), "[]"))
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return netip.Addr{}, httpapi.NewError(http.StatusBadRequest, "Invalid image URL host")
	}
	var addrs []netip.Addr
	if parsed, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{parsed}
	} else {
		lookup := f.LookupIPAddr
		if lookup == nil {
			lookup = DefaultExternalImageFetcher().LookupIPAddr
		}
		var err error
		addrs, err = lookup(ctx, host)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return netip.Addr{}, httpapi.NewError(http.StatusBadGateway, "External image request timed out")
			}
			return netip.Addr{}, httpapi.NewError(http.StatusBadGateway, "Failed to fetch external image")
		}
	}
	if len(addrs) == 0 {
		return netip.Addr{}, httpapi.NewError(http.StatusBadRequest, "Invalid image URL host")
	}
	for _, a := range addrs {
		if !IsPublicIP(a) {
			return netip.Addr{}, httpapi.NewError(http.StatusBadRequest, "Invalid image URL host")
		}
	}
	return addrs[0], nil
}

// Fetch downloads, validates, and converts an external image to PNG.
func (f *ExternalImageFetcher) Fetch(ctx context.Context, inputURL string) ([]byte, string, error) {
	timeout := f.Timeout
	if timeout <= 0 {
		timeout = externalImageTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	current, err := parseExternalURL(inputURL, nil)
	if err != nil {
		return nil, "", err
	}

	dialFn := f.DialContext
	if dialFn == nil {
		dialFn = (&net.Dialer{Timeout: timeout}).DialContext
	}

	for attempt := 0; attempt <= externalImageMaxRedirects; attempt++ {
		pinnedAddr, err := f.resolvePublicAddress(ctx, current)
		if err != nil {
			return nil, "", err
		}
		if ctx.Err() != nil {
			return nil, "", httpapi.NewError(http.StatusBadGateway, "External image request timed out")
		}

		port := current.Port()
		if port == "" {
			if current.Scheme == "https" {
				port = "443"
			} else {
				port = "80"
			}
		}
		pinnedTarget := net.JoinHostPort(pinnedAddr.String(), port)

		transport := &http.Transport{
			DisableKeepAlives: true,
			Proxy:             nil,
			DialContext: func(dctx context.Context, network, _ string) (net.Conn, error) {
				if pinnedAddr.Is4() {
					return dialFn(dctx, "tcp4", pinnedTarget)
				}
				return dialFn(dctx, "tcp6", pinnedTarget)
			},
		}
		client := &http.Client{
			Transport: transport,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, current.String(), nil)
		if err != nil {
			return nil, "", httpapi.NewError(http.StatusBadRequest, "Invalid url")
		}
		req.Header.Set("Accept", "image/jpeg,image/png,image/webp")
		req.Header.Set("User-Agent", "delb/external-image-fetcher")

		resp, err := client.Do(req)
		if err != nil {
			transport.CloseIdleConnections()
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, "", httpapi.NewError(http.StatusBadGateway, "External image request timed out")
			}
			return nil, "", httpapi.NewError(http.StatusBadGateway, "Failed to fetch external image")
		}

		status := resp.StatusCode
		if status == 301 || status == 302 || status == 303 || status == 307 || status == 308 {
			loc := resp.Header.Get("Location")
			_ = resp.Body.Close()
			transport.CloseIdleConnections()
			if attempt == externalImageMaxRedirects || loc == "" {
				return nil, "", httpapi.NewError(http.StatusBadGateway, "Failed to fetch external image")
			}
			nextURL, perr := parseExternalURL(loc, current)
			if perr != nil {
				return nil, "", perr
			}
			current = nextURL
			continue
		}

		if status < 200 || status >= 300 {
			_ = resp.Body.Close()
			transport.CloseIdleConnections()
			return nil, "", httpapi.NewError(http.StatusBadGateway, "Failed to fetch external image")
		}

		if cl := resp.Header.Get("Content-Length"); cl != "" {
			if n, perr := strconv.ParseInt(cl, 10, 64); perr == nil && n > externalImageMaxBytes {
				_ = resp.Body.Close()
				transport.CloseIdleConnections()
				return nil, "", httpapi.NewError(http.StatusRequestEntityTooLarge, "External image is too large")
			}
		}

		raw, rerr := io.ReadAll(io.LimitReader(resp.Body, externalImageMaxBytes+1))
		_ = resp.Body.Close()
		transport.CloseIdleConnections()
		if rerr != nil {
			if errors.Is(rerr, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, "", httpapi.NewError(http.StatusBadGateway, "External image request timed out")
			}
			return nil, "", httpapi.NewError(http.StatusBadGateway, "Failed to fetch external image")
		}
		if int64(len(raw)) > externalImageMaxBytes {
			return nil, "", httpapi.NewError(http.StatusRequestEntityTooLarge, "External image is too large")
		}

		pngBytes, verr := ValidateRasterImageForExternalFetch(raw, externalImageMaxPixels, externalImageMaxBytes)
		if verr != nil {
			var httpErr *httpapi.HTTPError
			if errors.As(verr, &httpErr) {
				return nil, "", httpErr
			}
			return nil, "", httpapi.NewError(http.StatusBadGateway, "Failed to fetch external image")
		}
		return pngBytes, "image/png", nil
	}

	return nil, "", httpapi.NewError(http.StatusBadGateway, "Failed to fetch external image")
}
