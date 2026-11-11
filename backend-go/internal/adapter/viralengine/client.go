// Package viralengine is a minimal MCP (JSON-RPC 2.0 over streamable HTTP)
// client for the ViralEngine backend that lists viral Instagram signals.
package viralengine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
)

// DefaultURL is the ViralEngine MCP endpoint.
const DefaultURL = "https://backend-production-226f.up.railway.app/mcp/"

// Client opens a fresh MCP session per call, as the Node scripts did.
type Client struct {
	http  *http.Client
	url   string
	token string
	name  string
	id    atomic.Int64
}

// New returns a client authenticated with token. name is the clientInfo name.
func New(httpClient *http.Client, url, token, name string) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	return &Client{http: httpClient, url: url, token: token, name: name}
}

// NewFromTokenFile reads the bearer token from path (e.g. ~/.viralengine_token).
func NewFromTokenFile(path, name string) (*Client, error) {
	b, err := os.ReadFile(path) //nolint:gosec // G304: fixed config path
	if err != nil {
		return nil, fmt.Errorf("reading viralengine token (buat dulu %s, chmod 600): %w", path, err)
	}

	return New(nil, DefaultURL, strings.TrimSpace(string(b)), name), nil
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func (c *Client) post(ctx context.Context, method string, params any, session string) (rpcResponse, string, int, error) {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": c.id.Add(1), "method": method, "params": params})
	if err != nil {
		return rpcResponse{}, "", 0, fmt.Errorf("encoding %s: %w", method, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return rpcResponse{}, "", 0, fmt.Errorf("building %s: %w", method, err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream") // streamable-http needs both
	req.Header.Set("Authorization", "Bearer "+c.token)

	if session != "" {
		req.Header.Set("Mcp-Session-Id", session)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return rpcResponse{}, "", 0, fmt.Errorf("%s: %w", method, err)
	}

	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return rpcResponse{}, "", 0, fmt.Errorf("reading %s: %w", method, err)
	}

	sid := resp.Header.Get("Mcp-Session-Id")
	if sid == "" {
		sid = session
	}

	data := raw
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		data = lastSSEData(raw)
	}

	var out rpcResponse

	_ = json.Unmarshal(data, &out) // notifications have no JSON body

	return out, sid, resp.StatusCode, nil
}

// lastSSEData returns the last non-empty "data:" payload of an SSE body.
func lastSSEData(raw []byte) []byte {
	var last []byte

	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)

	for sc.Scan() {
		if d, ok := strings.CutPrefix(sc.Text(), "data:"); ok && strings.TrimSpace(d) != "" {
			last = []byte(strings.TrimSpace(d))
		}
	}

	if last == nil {
		return raw
	}

	return last
}

func (c *Client) handshake(ctx context.Context) (string, json.RawMessage, error) {
	res, sid, code, err := c.post(ctx, "initialize", map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": c.name, "version": "0.1.0"},
	}, "")
	if err != nil {
		return "", nil, err
	}

	if code != http.StatusOK {
		return "", nil, fmt.Errorf("initialize failed: %d %s", code, res.Error)
	}

	_, _, _, _ = c.post(ctx, "notifications/initialized", map[string]any{}, sid) // no response expected

	return sid, res.Result, nil
}

// Tools returns the raw tools/list result.
func (c *Client) Tools(ctx context.Context) (json.RawMessage, error) {
	sid, _, err := c.handshake(ctx)
	if err != nil {
		return nil, err
	}

	res, _, _, err := c.post(ctx, "tools/list", map[string]any{}, sid)
	if err != nil {
		return nil, err
	}

	return res.Result, nil
}

// CallRaw runs tools/call and returns the whole JSON-RPC response object.
func (c *Client) CallRaw(ctx context.Context, tool string, args any) (json.RawMessage, error) {
	sid, _, err := c.handshake(ctx)
	if err != nil {
		return nil, err
	}

	res, _, _, err := c.post(ctx, "tools/call", map[string]any{"name": tool, "arguments": args}, sid)
	if err != nil {
		return nil, err
	}

	return json.Marshal(res)
}

// Call runs tools/call and decodes its structured result into out. MCP
// servers put it in structuredContent, or as JSON text in content[0].
func (c *Client) Call(ctx context.Context, tool string, args, out any) error {
	sid, _, err := c.handshake(ctx)
	if err != nil {
		return err
	}

	res, _, _, err := c.post(ctx, "tools/call", map[string]any{"name": tool, "arguments": args}, sid)
	if err != nil {
		return err
	}

	var r struct {
		StructuredContent json.RawMessage `json:"structuredContent"`
		Content           []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}

	if len(res.Result) == 0 {
		return fmt.Errorf("%s: empty result %s", tool, res.Error)
	}

	if err := json.Unmarshal(res.Result, &r); err != nil {
		return fmt.Errorf("decoding %s result: %w", tool, err)
	}

	payload := []byte(r.StructuredContent)
	if len(payload) == 0 || string(payload) == "null" {
		for _, ct := range r.Content {
			if ct.Type == "text" {
				payload = []byte(ct.Text)
				break
			}
		}
	}

	if len(payload) == 0 {
		payload = res.Result
	}

	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("decoding %s payload: %w", tool, err)
	}

	return nil
}
