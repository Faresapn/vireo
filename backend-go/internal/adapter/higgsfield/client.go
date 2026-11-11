// Package higgsfield submits render jobs to the Higgsfield API, polls them,
// and downloads the result. Retry rules mirror the Node scripts: a submit
// retries network errors under one idempotency key (no double charge), polling
// survives short network blips, and the paid-for download retries.
package higgsfield

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"
)

// BaseURL is the Higgsfield API root.
const BaseURL = "https://api.higgsfield.ai"

// FailedStatuses end a job without output.
var FailedStatuses = []string{"failed", "canceled", "error", "nsfw", "rejected", "content_moderation"}

// Client talks to Higgsfield.
type Client struct {
	HTTP        *http.Client
	PollEvery   time.Duration // default 5s
	PollTries   int           // default 480 (40 min: Seedance queues can pass 20 min)
	RetryDelay  time.Duration // submit/download retry delay, default 3s/4s
	Log         func(format string, args ...any)
	MaxNetFails int // consecutive poll network errors tolerated, default 6
	SubmitTries int // default 4
	DownloadTry int // default 5
}

func (c *Client) defaults() {
	if c.HTTP == nil {
		c.HTTP = &http.Client{Timeout: 2 * time.Minute}
	}

	if c.PollEvery == 0 {
		c.PollEvery = 5 * time.Second
	}

	if c.PollTries == 0 {
		c.PollTries = 480
	}

	if c.RetryDelay == 0 {
		c.RetryDelay = 3 * time.Second
	}

	if c.Log == nil {
		c.Log = func(string, ...any) {}
	}

	if c.MaxNetFails == 0 {
		c.MaxNetFails = 6
	}

	if c.SubmitTries == 0 {
		c.SubmitTries = 4
	}

	if c.DownloadTry == 0 {
		c.DownloadTry = 5
	}
}

// Submission is Higgsfield's answer to a submit.
type Submission struct {
	RequestID string          `json:"request_id"`
	StatusURL string          `json:"status_url"`
	Raw       json.RawMessage `json:"-"`
}

// Status is one poll answer.
type Status struct {
	Status string `json:"status"`
	Video  *struct {
		URL string `json:"url"`
	} `json:"video"`
	Error         string          `json:"error"`
	Message       string          `json:"message"`
	Detail        json.RawMessage `json:"detail"`
	FailureReason string          `json:"failure_reason"`
	Reason        string          `json:"reason"`
	Data          *struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	} `json:"data"`
	Raw json.RawMessage `json:"-"`
}

// ReasonText picks the most specific failure message.
func (s Status) ReasonText() string {
	for _, r := range []string{s.Error, s.Message, detailText(s.Detail), s.FailureReason, s.Reason} {
		if r != "" {
			return r
		}
	}

	if s.Data != nil {
		if s.Data.Error != "" {
			return s.Data.Error
		}

		return s.Data.Message
	}

	return ""
}

func detailText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}

	return ""
}

// JobError is a job that ended in a failed status (nsfw, failed, ...).
type JobError struct {
	Status string
	Reason string
}

func (e *JobError) Error() string { return fmt.Sprintf("%s: %s", e.Status, truncate(e.Reason, 300)) }

// ErrPollTimeout means the job was still running after PollTries polls. The
// render may still finish; the request id can be re-polled later.
var ErrPollTimeout = errors.New("poll timeout")

func newIdemKey(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)

	return fmt.Sprintf("%s-%d-%s", prefix, time.Now().UnixMilli(), hex.EncodeToString(b))
}

// Submit posts a job body to endpoint. Network errors are retried with the
// same Idempotency-Key, so a retry never starts a second paid render.
func (c *Client) Submit(ctx context.Context, endpoint, key, idemPrefix string, body any) (Submission, error) {
	c.defaults()

	payload, err := json.Marshal(body)
	if err != nil {
		return Submission{}, fmt.Errorf("encoding submit body: %w", err)
	}

	idem := newIdemKey(idemPrefix)

	var lastErr error

	for attempt := 1; attempt <= c.SubmitTries; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
		if err != nil {
			return Submission{}, fmt.Errorf("building submit: %w", err)
		}

		req.Header.Set("Authorization", "Key "+key)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", idem)

		resp, err := c.HTTP.Do(req)
		if err != nil {
			lastErr = err
			c.Log("submit net-retry %d/%d (%s)", attempt, c.SubmitTries, truncate(err.Error(), 40))

			if err := sleep(ctx, c.RetryDelay); err != nil {
				return Submission{}, err
			}

			continue
		}

		raw, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()

		if err != nil {
			return Submission{}, fmt.Errorf("reading submit response: %w", err)
		}

		var sub Submission

		_ = json.Unmarshal(raw, &sub)
		sub.Raw = raw

		return sub, nil
	}

	return Submission{}, fmt.Errorf("submit network failed: %w", lastErr)
}

// GetStatus fetches one status. found is false when the key does not own the
// request (Higgsfield answers with a "detail" error and no status).
func (c *Client) GetStatus(ctx context.Context, statusURL, key string) (Status, error) {
	c.defaults()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, statusURL, nil)
	if err != nil {
		return Status{}, fmt.Errorf("building status request: %w", err)
	}

	req.Header.Set("Authorization", "Key "+key)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Status{}, fmt.Errorf("status request: %w", err)
	}

	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return Status{}, fmt.Errorf("reading status: %w", err)
	}

	var st Status
	if err := json.Unmarshal(raw, &st); err != nil {
		return Status{}, fmt.Errorf("decoding status: %w", err)
	}

	st.Raw = raw

	return st, nil
}

// StatusURL builds the status endpoint of a request id.
func StatusURL(requestID string) string { return BaseURL + "/requests/" + requestID + "/status" }

// Poll waits until the job completes or fails.
func (c *Client) Poll(ctx context.Context, statusURL, key string) (Status, error) {
	c.defaults()

	netFails := 0

	for i := range c.PollTries {
		st, err := c.GetStatus(ctx, statusURL, key)
		switch {
		case ctx.Err() != nil:
			return Status{}, ctx.Err()
		case err != nil:
			// The render keeps running on Higgsfield; ride out short blips.
			netFails++
			c.Log("poll %d: net-retry %d/%d (%s)", i+1, netFails, c.MaxNetFails, truncate(err.Error(), 40))

			if netFails >= c.MaxNetFails {
				return Status{}, fmt.Errorf("poll network failed %dx in a row: %w", netFails, err)
			}
		default:
			netFails = 0

			if done, err := c.settled(i, st); done {
				return st, err
			}
		}

		if err := sleep(ctx, c.PollEvery); err != nil {
			return Status{}, err
		}
	}

	return Status{}, ErrPollTimeout
}

// settled reports whether st ends the job, with the error for a failed one.
func (c *Client) settled(i int, st Status) (bool, error) {
	c.Log("poll %d: %s", i+1, st.Status)

	if st.Status == "completed" {
		return true, nil
	}

	if slices.Contains(FailedStatuses, st.Status) {
		c.Log("FULL STATUS RESPONSE → %s", truncate(string(st.Raw), 800))
		return true, &JobError{Status: st.Status, Reason: st.ReasonText()}
	}

	return false, nil
}

// Download fetches the finished video, retrying: the render is already paid for.
func (c *Client) Download(ctx context.Context, url string) ([]byte, error) {
	c.defaults()

	var lastErr error

	for attempt := 1; attempt <= c.DownloadTry; attempt++ {
		b, err := c.get(ctx, url)
		if err == nil {
			return b, nil
		}

		lastErr = err
		c.Log("download net-retry %d/%d (%s)", attempt, c.DownloadTry, truncate(err.Error(), 40))

		if err := sleep(ctx, c.RetryDelay); err != nil {
			return nil, err
		}
	}

	return nil, fmt.Errorf("download failed: %w", lastErr)
}

func (c *Client) get(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("building download: %w", err)
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download: %w", err)
	}

	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("download HTTP %d", resp.StatusCode)
	}

	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading download: %w", err)
	}

	return b, nil
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}

	return s[:n]
}
