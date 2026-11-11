package entity_test

import (
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

func TestRefDuration(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		src    float64
		want   int
		result int
	}{
		{"strictly below source", 9.2, 0, 9},
		{"whole seconds still drop one", 8.0, 0, 7},
		{"short refs floor at 4", 2.5, 0, 4},
		{"long refs cap at 30", 45, 0, 30},
		{"explicit duration wins", 20, 10, 10},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := entity.RefDuration(tt.src, tt.want); got != tt.result {
				t.Fatalf("RefDuration(%v, %d) = %d, want %d", tt.src, tt.want, got, tt.result)
			}
		})
	}
}

func TestI2VDuration(t *testing.T) {
	t.Parallel()

	for want, exp := range map[int]int{0: 4, 5: 4, 10: 10, 15: 14, 31: 30, 2: 4} {
		if got := entity.I2VDuration(want); got != exp {
			t.Errorf("I2VDuration(%d) = %d, want %d", want, got, exp)
		}
	}
}

func TestEngineRouting(t *testing.T) {
	t.Parallel()

	tests := []struct {
		e      entity.Engine
		voices bool
		eff    entity.Engine
		slot   entity.KeySlot
	}{
		{entity.EngineSeedance, false, entity.EngineSeedance25, entity.SlotSeedance},
		{entity.EngineWanPrime, false, entity.EngineWanPrime, entity.SlotWan},
		{entity.EngineGenjutsu, false, entity.EngineGenjutsu, entity.SlotSeedance},
		{entity.EngineGenjutsuLight, false, entity.EngineGenjutsuLight, entity.SlotWan},
		{entity.EngineWan, true, entity.EngineSeedance25, entity.SlotSeedance},
	}
	for _, tt := range tests {
		t.Run(string(tt.e), func(t *testing.T) {
			t.Parallel()

			eff := tt.e.Effective(tt.voices)
			if eff != tt.eff || eff.KeySlot() != tt.slot {
				t.Fatalf("Effective = %s (%s), want %s (%s)", eff, eff.KeySlot(), tt.eff, tt.slot)
			}
		})
	}
}

func TestEngineBody(t *testing.T) {
	t.Parallel()

	in := entity.RenderInput{RefURL: "r", ImageURLs: []string{"i"}, AudioURLs: []string{"a"}, Prompt: "p", Resolution: "1080p", Duration: 40}

	tests := []struct {
		name string
		e    entity.Engine
		key  string
		want any
	}{
		{"seedance 2.0 caps at 15s", entity.EngineSeedance, "duration", 15},
		{"seedance 2.5 caps at 30s", entity.EngineSeedance25, "duration", 30},
		{"wan only 480p or 720p", entity.EngineWanPrime, "resolution", "720p"},
		{"genjutsu takes a single video_url", entity.EngineGenjutsu, "video_url", "r"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := tt.e.Body(in)[tt.key]; got != tt.want {
				t.Fatalf("%s = %v, want %v", tt.key, got, tt.want)
			}
		})
	}

	if _, ok := entity.EngineSeedance25.Body(in)["audio_urls"]; !ok {
		t.Fatal("seedance 2.5 must carry voice references")
	}

	if _, ok := entity.EngineSeedance.Body(in)["audio_urls"]; ok {
		t.Fatal("only seedance 2.5 takes audio_urls")
	}
}
