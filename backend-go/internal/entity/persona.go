// Package entity holds the domain types shared by every layer. It imports
// nothing from the rest of the module.
package entity

import "errors"

// ErrPersonaNotFound is returned when no persona has the requested id.
var ErrPersonaNotFound = errors.New("persona not found")

// Persona is one content channel: a locked character, a master prompt and the
// settings that drive its renders. Nullable columns are pointers so they
// round-trip to JSON as null, matching the Node API the dashboard was built on.
type Persona struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	Niche            string  `json:"niche"`
	Platform         string  `json:"platform"`
	MasterPrompt     *string `json:"master_prompt"`
	CharacterImg     *string `json:"character_img"`
	Aspect           *string `json:"aspect"`
	ViralSource      *string `json:"viral_source"`
	ViralClusterSlug *string `json:"viral_cluster_slug"`
	Archived         int64   `json:"archived"`
	AutoInstruction  *string `json:"auto_instruction"`
	AutoMode         *int64  `json:"auto_mode"`
	AutoEngine       *string `json:"auto_engine"`
	CharMode         *string `json:"char_mode"`
	AudioMode        *string `json:"audio_mode"`
	AudioRef         *string `json:"audio_ref"`
	DailyAuto        *int64  `json:"daily_auto"`
	DailyAutoLast    *string `json:"daily_auto_last"`
	DailyAutoStatus  *string `json:"daily_auto_status"`
	RenderRes        *string `json:"render_res"`
	SkipQC           *int64  `json:"skip_qc"`
	DriveFolderID    *string `json:"drive_folder_id"`
	CreatedAt        *string `json:"created_at"`
	UpdatedAt        *string `json:"updated_at"`

	StageCounts
}

// StageCounts is how many of a persona's videos sit in each pipeline column.
type StageCounts struct {
	Inbox      int64 `json:"cnt_inbox"`
	Shortlist  int64 `json:"cnt_shortlist"`
	Generating int64 `json:"cnt_gen"`
	QC         int64 `json:"cnt_qc"`
	Done       int64 `json:"cnt_done"`
}

// Resolution is the render resolution the persona uses by default.
func (p Persona) Resolution() string {
	if p.RenderRes != nil && *p.RenderRes == Res480 {
		return Res480
	}

	return Res720
}
