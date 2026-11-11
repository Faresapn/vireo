// Package llm talks to the local OpenAI-compatible chat endpoint
// (localhost:20128) that serves the vision model used for prompt writing,
// reference screening and idea generation.
package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// Defaults match the Node scripts.
const (
	DefaultURL   = "http://localhost:20128/v1/chat/completions"
	DefaultModel = "cc/claude-opus-4-8"
)

// Part is one piece of a multimodal user message.
type Part struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *imageURL `json:"image_url,omitempty"`
}

type imageURL struct {
	URL string `json:"url"`
}

// Text builds a text part.
func Text(s string) Part { return Part{Type: "text", Text: s} }

// JPEG builds an inline image part from JPEG bytes.
func JPEG(b []byte) Part {
	return Part{Type: "image_url", ImageURL: &imageURL{URL: "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(b)}}
}

// Client calls the chat endpoint.
type Client struct {
	http  *http.Client
	url   string
	model string
	key   string
}

// New returns a client. key is sent as a Bearer token.
func New(httpClient *http.Client, url, model, key string) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	return &Client{http: httpClient, url: url, model: model, key: key}
}

// NewFromKeyFile reads the API key from path (e.g. ~/.llm_vision_key).
func NewFromKeyFile(path string) (*Client, error) {
	b, err := os.ReadFile(path) //nolint:gosec // G304: fixed config path
	if err != nil {
		return nil, fmt.Errorf("reading llm key: %w", err)
	}

	return New(nil, DefaultURL, DefaultModel, strings.TrimSpace(string(b))), nil
}

type message struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

// Chat sends a system prompt plus a plain-text user message.
func (c *Client) Chat(ctx context.Context, system, user string, maxTokens int) (string, error) {
	return c.send(ctx, system, user, maxTokens)
}

// ChatParts sends a system prompt plus a multimodal user message.
func (c *Client) ChatParts(ctx context.Context, system string, parts []Part, maxTokens int) (string, error) {
	return c.send(ctx, system, parts, maxTokens)
}

func (c *Client) send(ctx context.Context, system string, user any, maxTokens int) (string, error) {
	body, err := json.Marshal(map[string]any{
		"model":      c.model,
		"max_tokens": maxTokens,
		"stream":     false,
		"messages":   []message{{Role: "system", Content: system}, {Role: "user", Content: user}},
	})
	if err != nil {
		return "", fmt.Errorf("encoding llm request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("building llm request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.key)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("llm request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("reading llm response: %w", err)
	}

	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("llm %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}

	return strings.TrimSpace(parseReply(raw)), nil
}

// parseReply accepts a plain JSON completion or, when the proxy streams anyway,
// a server-sent-event body whose deltas are concatenated.
func parseReply(raw []byte) string {
	var j struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &j); err == nil {
		if len(j.Choices) > 0 {
			return j.Choices[0].Message.Content
		}

		return ""
	}

	var out strings.Builder

	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())

		payload, ok := strings.CutPrefix(line, "data:")
		if !ok {
			continue
		}

		payload = strings.TrimSpace(payload)
		if payload == "[DONE]" {
			break
		}

		var chunk struct {
			Choices []struct {
				Delta   struct{ Content string } `json:"delta"`
				Message struct{ Content string } `json:"message"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil || len(chunk.Choices) == 0 {
			continue
		}

		out.WriteString(chunk.Choices[0].Delta.Content)
		out.WriteString(chunk.Choices[0].Message.Content)
	}

	return out.String()
}

// ErrNoJSON is returned by ExtractJSON when the reply has no {...} block.
var ErrNoJSON = errors.New("no JSON object in llm reply")

// ExtractJSON decodes the outermost {...} block of reply into v.
func ExtractJSON(reply string, v any) error {
	start, end := strings.IndexByte(reply, '{'), strings.LastIndexByte(reply, '}')
	if start < 0 || end <= start {
		return fmt.Errorf("%w: %s", ErrNoJSON, truncate(reply, 120))
	}

	if err := json.Unmarshal([]byte(reply[start:end+1]), v); err != nil {
		return fmt.Errorf("decoding llm json: %w", err)
	}

	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}

	return s[:n]
}
