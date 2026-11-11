package entity

// Stage is a video's column in the pipeline.
type Stage string

// Pipeline stages, in order.
const (
	StageInbox      Stage = "inbox"
	StageShortlist  Stage = "shortlist"
	StageApproved   Stage = "approved"
	StageGenerating Stage = "generating"
	StageQC         Stage = "qc"
	StageDone       Stage = "done"
)

// Valid reports whether s is a stage the pipeline knows about.
func (s Stage) Valid() bool {
	switch s {
	case StageInbox, StageShortlist, StageApproved, StageGenerating, StageQC, StageDone:
		return true
	}

	return false
}

// IngestOrder is the ViralEngine sort a reference was pulled with.
type IngestOrder string

// Known sorts.
const (
	OrderVelocity IngestOrder = "velocity"
	OrderDate     IngestOrder = "date"
)

// Valid reports whether o is a known sort.
func (o IngestOrder) Valid() bool { return o == OrderVelocity || o == OrderDate }

// Video is one reference clip and everything rendered from it.
type Video struct {
	ID           int64    `json:"id"`
	Stage        Stage    `json:"stage"`
	SourceURL    *string  `json:"source_url"`
	LocalRef     *string  `json:"local_ref"`
	DurationS    *float64 `json:"duration_s"`
	FaceCount    *int64   `json:"face_count"`
	CutCount     *int64   `json:"cut_count"`
	RefScore     *int64   `json:"ref_score"`
	RefNotes     *string  `json:"ref_notes"`
	Shortcode    *string  `json:"shortcode"`
	Views        *int64   `json:"views"`
	ViewsPerHour *float64 `json:"views_per_hour"`
	Caption      *string  `json:"caption"`
	Creator      *string  `json:"creator"`
	PromptUsed   *string  `json:"prompt_used"`
	IdeaSummary  *string  `json:"idea_summary"`
	MasterPrompt *string  `json:"master_prompt"`
	HFRequestID  *string  `json:"hf_request_id"`
	Output480    *string  `json:"output_480"`
	Output1080   *string  `json:"output_1080"`
	QCStatus     *string  `json:"qc_status"`
	QCNotes      *string  `json:"qc_notes"`
	GenEngine    *string  `json:"gen_engine"`
	GenError     *string  `json:"gen_error"`
	GenStartedAt *string  `json:"gen_started_at"`
	IngestOrder  *string  `json:"ingest_order"`
	CreatedAt    *string  `json:"created_at"`
}

// VideoFilter narrows a persona's video list. Zero values mean "no filter".
type VideoFilter struct {
	Stage Stage
	Order IngestOrder
}
