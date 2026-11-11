package entity

import "math"

// Render resolutions.
const (
	Res480 = "480p"
	Res720 = "720p"
)

// Engine is a Higgsfield model the studio renders with.
type Engine string

// Engines. "seedance" always renders on Seedance 2.5 (2.0 restyles the scene
// and locks the character weakly), see Effective.
const (
	EngineGenjutsu      Engine = "genjutsu"
	EngineGenjutsuLight Engine = "genjutsu-light"
	EngineSeedance      Engine = "seedance"
	EngineSeedance25    Engine = "seedance-2.5"
	EngineWan           Engine = "wan"
	EngineWanPrime      Engine = "wan-prime"
)

var endpoints = map[Engine]string{
	EngineGenjutsu:      "/higgsfield/genjutsu/motion-transfer/v1.0",
	EngineGenjutsuLight: "/higgsfield/genjutsu-light/motion-transfer/v1.0",
	EngineSeedance:      "/bytedance/seedance-2.0/reference-to-video",
	EngineSeedance25:    "/bytedance/seedance-2.5/reference-to-video",
	EngineWan:           "/alibaba/wan-3.0/reference-to-video",
	EngineWanPrime:      "/alibaba/wan-3.0-prime/reference-to-video",
}

// Valid reports whether e is a known engine.
func (e Engine) Valid() bool { _, ok := endpoints[e]; return ok }

// Path is the engine's API path under the Higgsfield base URL.
func (e Engine) Path() string { return endpoints[e] }

// KeySlot is which Higgsfield account pays: Seedance and full Genjutsu use
// the second key, Wan and Genjutsu Light the first. The names share prefixes,
// so the map is explicit.
func (e Engine) KeySlot() KeySlot {
	switch e {
	case EngineGenjutsu, EngineSeedance, EngineSeedance25:
		return SlotSeedance
	case EngineGenjutsuLight, EngineWan, EngineWanPrime:
		return SlotWan
	}

	return SlotWan
}

// IsSeedance reports whether e is a Seedance model.
func (e Engine) IsSeedance() bool { return e == EngineSeedance || e == EngineSeedance25 }

// IsWan reports whether e is a Wan model.
func (e Engine) IsWan() bool { return e == EngineWan || e == EngineWanPrime }

// Effective is the engine actually used: "seedance" means 2.5, and voice
// references (only Seedance 2.5 takes audio_urls) force 2.5.
func (e Engine) Effective(hasVoiceRefs bool) Engine {
	if e == EngineSeedance || hasVoiceRefs {
		return EngineSeedance25
	}

	return e
}

// RenderInput is everything a motion-transfer body needs.
type RenderInput struct {
	RefURL     string
	ImageURLs  []string
	AudioURLs  []string // only sent on Seedance 2.5
	Prompt     string
	Resolution string
	Duration   int
}

// Body builds the request body for e, mirroring the Node ENGINES table.
func (e Engine) Body(in RenderInput) map[string]any {
	switch e {
	case EngineGenjutsu, EngineGenjutsuLight:
		return map[string]any{"video_url": in.RefURL, "image_urls": in.ImageURLs, "prompt": in.Prompt, "resolution": in.Resolution}
	case EngineSeedance, EngineSeedance25:
		maxDur := 30
		if e == EngineSeedance {
			maxDur = 15
		}

		b := map[string]any{
			"video_urls": []string{in.RefURL}, "image_urls": in.ImageURLs, "prompt": in.Prompt,
			"resolution": in.Resolution, "aspect_ratio": "9:16", "duration": min(in.Duration, maxDur),
			"generate_audio": true, "bitrate_mode": "high",
		}
		if e == EngineSeedance25 && len(in.AudioURLs) > 0 {
			b["audio_urls"] = in.AudioURLs
		}

		return b
	case EngineWan, EngineWanPrime: // 2–30s, 480p or 720p
		res := Res720
		if in.Resolution == Res480 {
			res = Res480
		}

		return map[string]any{
			"video_urls": []string{in.RefURL}, "image_urls": in.ImageURLs, "prompt": in.Prompt,
			"resolution": res, "aspect_ratio": "9:16", "duration": min(max(in.Duration, 2), 30),
		}
	}

	return nil
}

// RefDuration is the duration to request for a reference of srcLen seconds.
// Seedance rejects a duration equal to or longer than the source ("interpreted
// as video editing"), so it is ceil(srcLen)-1, at least 4. want > 0 overrides.
// The result is clamped to 4..30.
func RefDuration(srcLen float64, want int) int {
	ref := max(4, int(math.Ceil(srcLen))-1)
	if want <= 0 {
		want = ref
	}

	return min(max(want, 4), 30)
}

// I2VDuration is the duration for an image-only Seedance render: 4..30 and
// even (Seedance rejects odd values there). want <= 0 means 5, giving 4.
func I2VDuration(want int) int {
	if want <= 0 {
		want = 5
	}

	d := min(max(want, 4), 30)
	if d%2 != 0 {
		d--
	}

	return max(d, 4)
}

// OutputColumn is the videos column a resolution is stored in: 480p has its
// own, anything higher uses the hi-res slot.
func OutputColumn(resolution string) string {
	if resolution == Res480 {
		return "output_480"
	}

	return "output_1080"
}

// NormalizeResolution maps anything unknown to 720p.
func NormalizeResolution(r string) string {
	switch r {
	case "480p", "720p", "1080p":
		return r
	}

	return "720p"
}
