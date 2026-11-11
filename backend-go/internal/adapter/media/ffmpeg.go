// Package media wraps ffprobe, ffmpeg and yt-dlp. Every call runs the binary
// directly (no shell) with the context's deadline.
package media

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Tools runs the media binaries. Zero value uses binaries from PATH.
type Tools struct {
	FFmpeg, FFprobe, YTDLP string
}

func (t Tools) bin(name, override string) string {
	if override != "" {
		return override
	}

	return name
}

func (t Tools) run(ctx context.Context, bin string, args ...string) ([]byte, error) {
	var stdout, stderr bytes.Buffer

	cmd := exec.CommandContext(ctx, bin, args...) //nolint:gosec // G204: fixed binaries, no shell

	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), fmt.Errorf("%s: %w: %s", filepath.Base(bin), err, lastLine(stderr.String()))
	}

	return stdout.Bytes(), nil
}

// Stream is one stream reported by ffprobe.
type Stream struct {
	CodecType string `json:"codec_type"`
	CodecName string `json:"codec_name"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Duration  string `json:"duration"`
}

// Probe is what ffprobe says about a file.
type Probe struct {
	Streams []Stream `json:"streams"`
	Format  struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// Video returns the first video stream, if any.
func (p Probe) Video() (Stream, bool) {
	for _, s := range p.Streams {
		if s.CodecType == "video" {
			return s, true
		}
	}

	return Stream{}, false
}

// HasAudio reports whether any stream is audio.
func (p Probe) HasAudio() bool {
	for _, s := range p.Streams {
		if s.CodecType == "audio" {
			return true
		}
	}

	return false
}

// Seconds is the container duration (0 when unknown).
func (p Probe) Seconds() float64 { return atof(p.Format.Duration) }

// Probe reads streams and duration.
func (t Tools) Probe(ctx context.Context, path string) (Probe, error) {
	out, err := t.run(ctx, t.bin("ffprobe", t.FFprobe), "-v", "error",
		"-show_entries", "stream=codec_type,codec_name,width,height,duration",
		"-show_entries", "format=duration", "-of", "json", path)
	if err != nil {
		return Probe{}, err
	}

	var p Probe
	if err := json.Unmarshal(out, &p); err != nil {
		return Probe{}, fmt.Errorf("decoding ffprobe output: %w", err)
	}

	return p, nil
}

// Duration returns the container duration in seconds.
func (t Tools) Duration(ctx context.Context, path string) (float64, error) {
	p, err := t.Probe(ctx, path)
	if err != nil {
		return 0, err
	}

	return p.Seconds(), nil
}

// VideoSeconds is the first video stream's length, falling back to the
// container length; 0 if neither can be read. Trailing audio can make the
// container longer than the video, which matters for Seedance durations.
func (t Tools) VideoSeconds(ctx context.Context, path string) float64 {
	p, err := t.Probe(ctx, path)
	if err != nil {
		return 0
	}

	if v, ok := p.Video(); ok && atof(v.Duration) > 0 {
		return atof(v.Duration)
	}

	return p.Seconds()
}

// Frames grabs one JPEG frame at each fraction of the duration (e.g. 0.1, 0.5,
// 0.9), scaled to width px wide. A zero duration counts as fallbackDur.
func (t Tools) Frames(ctx context.Context, path string, fractions []float64, width int, fallbackDur float64) ([][]byte, error) {
	dur, err := t.Duration(ctx, path)
	if err != nil || dur <= 0 {
		dur = fallbackDur
	}

	dir, err := os.MkdirTemp("", "vireo-frames-*")
	if err != nil {
		return nil, fmt.Errorf("creating temp dir: %w", err)
	}

	defer func() { _ = os.RemoveAll(dir) }()

	frames := make([][]byte, 0, len(fractions))
	for i, f := range fractions {
		out := filepath.Join(dir, strconv.Itoa(i)+".jpg")
		if _, err := t.run(ctx, t.bin("ffmpeg", t.FFmpeg), "-y", "-ss", strconv.FormatFloat(dur*f, 'f', 2, 64),
			"-i", path, "-frames:v", "1", "-vf", fmt.Sprintf("scale=%d:-1", width), out); err != nil {
			return nil, err
		}

		b, err := os.ReadFile(out) //nolint:gosec // G304: our own temp file
		if err != nil {
			return nil, fmt.Errorf("reading frame: %w", err)
		}

		frames = append(frames, b)
	}

	return frames, nil
}

// NormalizeIngest re-encodes a freshly downloaded reference to h264 with a
// silent stereo track when it is not h264 or has no audio, replacing the file
// in place. It reports whether it transcoded and the original video codec.
func (t Tools) NormalizeIngest(ctx context.Context, path string) (bool, string, error) {
	p, err := t.Probe(ctx, path)
	if err != nil {
		return false, "", err
	}

	v, _ := p.Video()
	if v.CodecName == "h264" && p.HasAudio() {
		return false, v.CodecName, nil
	}

	tmp := strings.TrimSuffix(path, ".mp4") + "_h264.mp4"
	if _, err := t.run(ctx, t.bin("ffmpeg", t.FFmpeg), "-y", "-i", path,
		"-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
		mapFlag, "0:v", mapFlag, "1:a", tmp); err != nil {
		return false, v.CodecName, err
	}

	if err := os.Rename(tmp, path); err != nil {
		return false, v.CodecName, fmt.Errorf("replacing ref: %w", err)
	}

	return true, v.CodecName, nil
}

// Render limits learned from failed Higgsfield jobs (see scripts/generate.mjs).
const (
	RefMaxSeconds = 29   // engines reject refs over 30s; 30.0 exactly has failed too
	RefShortEdge  = 720  // Seedance rejects refs whose short edge is not 720
	ImageMaxPx    = 2048 // over-large character images fail as "parameters not supported"
)

// PrepareRef returns a render-safe copy of a reference: h264 + aac, at most
// RefMaxSeconds long, short edge exactly RefShortEdge. It keeps the original
// audio (Genjutsu carries it into the output) and only adds a silent track when
// there is none. temp is true when the caller must delete the returned file.
// Any failure falls back to the original file, as the Node code did.
func (t Tools) PrepareRef(ctx context.Context, src string, logf func(string, ...any)) (path string, temp bool) {
	p, err := t.Probe(ctx, src)
	if err != nil {
		return src, false
	}

	v, _ := p.Video()
	short := min(v.Width, v.Height)
	tooLong := p.Seconds() > 30
	wrongSize := short > 0 && short != RefShortEdge

	if tooLong {
		logf("ref is %.1fs (>30s engine limit) — trimming to %ds", p.Seconds(), RefMaxSeconds)
	}

	if wrongSize {
		logf("ref short-edge is %dpx (need %d) — normalizing", short, RefShortEdge)
	}

	if v.CodecName == "h264" && p.HasAudio() && !tooLong && !wrongSize {
		return src, false
	}

	tmp := strings.TrimSuffix(src, ".mp4") + "_h264tmp.mp4"
	if _, err := t.run(ctx, t.bin("ffmpeg", t.FFmpeg), refArgs(src, tmp, p.HasAudio(), tooLong, wrongSize)...); err != nil {
		return src, false
	}

	if _, err := os.Stat(tmp); err != nil {
		return src, false
	}

	return tmp, true
}

const mapFlag = "-map"

// refArgs builds the ffmpeg arguments of PrepareRef.
func refArgs(src, dst string, hasAudio, trim, rescale bool) []string {
	args := []string{"-y", "-i", src}
	maps := []string{mapFlag, "0:v", mapFlag, "0:a"}
	acodec := []string{"-c:a", "aac"}

	if !hasAudio {
		args = append(args, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100")
		maps = []string{mapFlag, "0:v", mapFlag, "1:a"}

		acodec = append(acodec, "-shortest")
	}

	if trim {
		args = append(args, "-t", strconv.Itoa(RefMaxSeconds))
	}

	if rescale {
		args = append(args, "-vf", fmt.Sprintf("scale='if(lt(iw,ih),%d,-2)':'if(lt(iw,ih),-2,%d)',scale=trunc(iw/2)*2:trunc(ih/2)*2", RefShortEdge, RefShortEdge))
	}

	args = append(args, "-c:v", "libx264", "-pix_fmt", "yuv420p")
	args = append(args, acodec...)
	args = append(args, maps...)

	return append(args, dst)
}

// DownscaleImage returns a copy of src whose long edge is at most maxPx, or
// src itself when it is already small enough or anything fails.
func (t Tools) DownscaleImage(ctx context.Context, src string, maxPx int, logf func(string, ...any)) (path string, temp bool) {
	p, err := t.Probe(ctx, src)
	if err != nil {
		return src, false
	}

	v, ok := p.Video()
	if !ok || v.Width == 0 || v.Height == 0 || (v.Width <= maxPx && v.Height <= maxPx) {
		return src, false
	}

	ext := strings.ToLower(filepath.Ext(src))

	outExt := ".jpg"
	if ext == ".png" {
		outExt = ".png"
	}

	tmp := strings.TrimSuffix(src, filepath.Ext(src)) + "_ds" + outExt

	logf("char %dx%d > %dpx — downscaling", v.Width, v.Height, maxPx)

	if _, err := t.run(ctx, t.bin("ffmpeg", t.FFmpeg), "-y", "-i", src, "-vf",
		fmt.Sprintf("scale='min(%d,iw)':'min(%d,ih)':force_original_aspect_ratio=decrease", maxPx, maxPx), tmp); err != nil {
		return src, false
	}

	if _, err := os.Stat(tmp); err != nil {
		return src, false
	}

	return tmp, true
}

// Download fetches a social video with yt-dlp into dest (mp4 preferred).
func (t Tools) Download(ctx context.Context, url, dest string) error {
	_, err := t.run(ctx, t.bin("yt-dlp", t.YTDLP), "--no-playlist", "-f", "b[ext=mp4]/mp4/best", "-o", dest, url)
	if err != nil {
		return err
	}

	if _, err := os.Stat(dest); err != nil {
		return fmt.Errorf("yt-dlp produced no file: %w", err)
	}

	return nil
}

// Timeout is a convenience for per-call deadlines.
func Timeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, d)
}

func atof(s string) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f
}

// lastLine keeps tool errors short; yt-dlp puts its "ERROR:" line last.
func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return s[i+1:]
	}

	return s
}
