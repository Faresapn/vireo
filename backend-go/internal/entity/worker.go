package entity

import "errors"

// ErrVideoNotFound is returned when a video does not exist or belongs to
// another persona.
var ErrVideoNotFound = errors.New("persona/video not found")

// NewRef is a freshly ingested reference video.
type NewRef struct {
	PersonaID    string
	SourceURL    string
	LocalRef     string // relative to the persona dir, e.g. refs/<cluster>_<code>.mp4
	DurationS    float64
	Shortcode    string
	Views        *int64
	ViewsPerHour *float64
	Caption      string
	Creator      *string
	IngestOrder  IngestOrder
}

// IdeaVector is one stored idea and its embedding.
type IdeaVector struct {
	Summary string
	Vector  []float64
}

// RenderDone is how a finished render is recorded.
type RenderDone struct {
	VideoID    int64
	Column     string // OutputColumn(resolution)
	OutputRel  string // e.g. output/720p/x.mp4
	Prompt     *string
	RequestID  *string
	Stage      Stage // StageQC, or StageDone for skip-QC personas
	ClearError bool
}

// RAGStats are first-try QC outcomes of a niche.
type RAGStats struct {
	FirstTryOK int
	FirstTries int
}

// AutoDone reports whether the niche is proven enough (>=30 first tries,
// >=95% OK) to skip manual QC.
func (r RAGStats) AutoDone() bool {
	return r.FirstTries >= 30 && r.Rate() >= 0.95
}

// Rate is the first-try OK rate (0 with no samples).
func (r RAGStats) Rate() float64 {
	if r.FirstTries == 0 {
		return 0
	}

	return float64(r.FirstTryOK) / float64(r.FirstTries)
}
