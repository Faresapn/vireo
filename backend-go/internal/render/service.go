package render

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/higgsfield"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/media"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// GenericPrompt is the last-resort motion-transfer prompt. A saved prompt equal
// to it is ignored so it never shadows the master prompt.
const GenericPrompt = "The scene follows the exact same sequence as the reference video, matching every movement frame-for-frame, replacing the main person with the reference character while keeping the original motion, setting, timing and energy unchanged."

// webStyleSheets are sent like the Higgsfield web app does: original-size
// character sheets, reversed (turnaround sheet first).
var webStyleSheets = map[string]bool{"mc-asthon-hall": true, "mc-kepin-extreme-1lvi": true}

var imageExt = regexp.MustCompile(`(?i)\.(png|jpe?g|webp)$`)

// Service runs renders.
type Service struct {
	repo        Repository
	transit     Transit
	media       Media
	hf          Higgsfield
	keys        Keys
	archive     Archiver
	personasDir string
	baseURL     string
	log         func(string, ...any)
	now         func() time.Time
	pick        func(int) int
}

// Config wires a Service.
type Config struct {
	Repo        Repository
	Transit     Transit
	Media       Media
	Higgsfield  Higgsfield
	Keys        Keys
	Archive     Archiver
	PersonasDir string
	BaseURL     string // default higgsfield.BaseURL
	Log         func(string, ...any)
	Now         func() time.Time
	Pick        func(int) int
}

// NewService builds a Service.
func NewService(c Config) *Service {
	s := &Service{
		repo: c.Repo, transit: c.Transit, media: c.Media, hf: c.Higgsfield, keys: c.Keys, archive: c.Archive,
		personasDir: c.PersonasDir, baseURL: c.BaseURL, log: c.Log, now: c.Now, pick: c.Pick,
	}
	if s.baseURL == "" {
		s.baseURL = higgsfield.BaseURL
	}

	if s.now == nil {
		s.now = time.Now
	}

	if s.pick == nil {
		s.pick = rand.IntN
	}

	if s.log == nil {
		s.log = func(string, ...any) {}
	}

	return s
}

// Result is printed as JSON on success.
type Result struct {
	OK        bool   `json:"ok"`
	Engine    string `json:"engine,omitempty"`
	RequestID string `json:"request_id,omitempty"`
	Recovered string `json:"recovered,omitempty"`
	Output    string `json:"output"`
	SizeMB    string `json:"size_mb"`
}

// Errors that end a render before anything is submitted.
var (
	ErrNoImages  = errors.New("no character images")
	ErrNoPrompt  = errors.New("no prompt (prompt_used/master_prompt all empty)")
	ErrNoImgFile = errors.New("no reference image files on disk")
	ErrNoRef     = errors.New("ref file missing")
	ErrNoRequest = errors.New("recover: request_id tidak tersimpan, cek hasil di web Higgsfield")
)

// session tracks transit uploads and temp files so every exit cleans up.
type session struct {
	s        *Service
	uploaded []string
	temps    []string
	stamp    string
}

func (s *Service) newSession() *session {
	return &session{s: s, stamp: strconv.FormatInt(s.now().UnixMilli(), 36)}
}

func (ss *session) upload(ctx context.Context, local, name string) (string, error) {
	url, err := ss.s.transit.Upload(ctx, local, name)
	if err != nil {
		return "", err
	}

	ss.uploaded = append(ss.uploaded, name)

	return url, nil
}

func (ss *session) cleanup() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute) // runs even after the render ctx ended
	defer cancel()

	for _, n := range ss.uploaded {
		ss.s.transit.Delete(ctx, n)
	}

	for _, t := range ss.temps {
		_ = os.Remove(t)
	}
}

func str(p *string) string {
	if p == nil {
		return ""
	}

	return *p
}

// jsStr mirrors a JS template literal of a nullable column: null prints "null".
func jsStr(p *string) string {
	if p == nil {
		return "null"
	}

	return *p
}

// Generate renders a reference video with the persona's character on engine.
// duration <= 0 derives it from the reference.
func (s *Service) Generate(ctx context.Context, personaID string, videoID int64, engine entity.Engine, resolution string, duration int) (Result, error) {
	p, err := s.repo.Persona(ctx, personaID)
	if err != nil {
		return Result{}, err
	}

	v, err := s.repo.Video(ctx, personaID, videoID)
	if err != nil {
		return Result{}, err
	}

	chars, err := s.characters(ctx, personaID, videoID)
	if err != nil {
		return Result{}, err
	}

	if v.LocalRef == nil {
		return Result{}, ErrNoRef
	}

	ss := s.newSession()
	defer ss.cleanup()

	in, ref, err := s.uploadInputs(ctx, ss, p, v, chars, engine)
	if err != nil {
		return Result{}, s.fail(ctx, videoID, err)
	}

	in.Prompt = pickPrompt(p, v)
	in.Resolution = resolution
	in.Duration = entity.RefDuration(s.sourceSeconds(ctx, ref, v), duration)

	eff := engine.Effective(len(in.AudioURLs) > 0)
	body := eff.Body(in)

	extra := ""
	if eff.IsSeedance() || eff.IsWan() {
		extra = fmt.Sprintf(" 9:16 %ds", in.Duration)
	}

	s.log("[%s] submit %s%s…", eff, resolution, extra)
	s.logBody(body, in.Prompt)

	outName := fmt.Sprintf("%s_%s_%s.mp4", jsStr(p.ViralClusterSlug), jsStr(v.Shortcode), resolution)

	res, err := s.submitAndFinish(ctx, p, videoID, eff, body, "gen", resolution, outName, &in.Prompt)
	if err != nil {
		return Result{}, err
	}

	res.Engine = string(engine)

	return res, nil
}

// characters lists the images to send: the video's or persona's set, plus a
// random animal, reversed for web-style personas.
func (s *Service) characters(ctx context.Context, personaID string, videoID int64) ([]string, error) {
	chars, err := s.repo.CharacterImages(ctx, personaID, videoID)
	if err != nil {
		return nil, err
	}

	if len(chars) == 0 {
		return nil, ErrNoImages
	}

	chars = append(chars, s.randomAnimal(personaID)...)
	if webStyleSheets[personaID] {
		slices.Reverse(chars)
	}

	return chars, nil
}

// uploadInputs prepares and uploads the reference, character images and
// voices. It returns the URLs and the local reference file that was sent.
func (s *Service) uploadInputs(ctx context.Context, ss *session, p entity.Persona, v entity.Video, chars []string, engine entity.Engine) (entity.RenderInput, string, error) {
	ref, tmp := s.media.PrepareRef(ctx, filepath.Join(s.personasDir, p.ID, *v.LocalRef), s.log)
	if tmp {
		ss.temps = append(ss.temps, ref)
	}

	s.log("[%s] uploading ref + %d chars…", engine, len(chars))

	refURL, err := ss.upload(ctx, ref, fmt.Sprintf("%s_%s_ref_%s.mp4", p.ID, jsStr(v.Shortcode), ss.stamp))
	if err != nil {
		return entity.RenderInput{}, "", err
	}

	images, err := s.uploadImages(ctx, ss, p.ID, chars)
	if err != nil {
		return entity.RenderInput{}, "", err
	}

	voices, err := s.uploadVoices(ctx, ss, p)
	if err != nil {
		return entity.RenderInput{}, "", err
	}

	return entity.RenderInput{RefURL: refURL, ImageURLs: images, AudioURLs: voices}, ref, nil
}

// uploadImages uploads the character images that exist on disk, keeping their
// position in the file name (char1, char3 when char2 is missing).
func (s *Service) uploadImages(ctx context.Context, ss *session, personaID string, chars []string) ([]string, error) {
	var urls []string

	for i, rel := range chars {
		local := filepath.Join(s.personasDir, personaID, rel)
		if _, err := os.Stat(local); err != nil {
			continue
		}

		if !webStyleSheets[personaID] {
			if ds, tmp := s.media.DownscaleImage(ctx, local, media.ImageMaxPx, s.log); tmp {
				ss.temps = append(ss.temps, ds)
				local = ds
			}
		}

		url, err := ss.upload(ctx, local, fmt.Sprintf("%s_char%d_%s%s", personaID, i+1, ss.stamp, filepath.Ext(local)))
		if err != nil {
			return nil, err
		}

		urls = append(urls, url)
	}

	return urls, nil
}

// sourceSeconds is the length of the video stream actually uploaded (trailing
// audio can make the container longer), then the stored duration, then 5s.
func (s *Service) sourceSeconds(ctx context.Context, ref string, v entity.Video) float64 {
	if n := s.media.VideoSeconds(ctx, ref); n > 0 {
		return n
	}

	if v.DurationS != nil && *v.DurationS > 0 {
		return *v.DurationS
	}

	return 5
}

// GenerateI2V renders an idea prompt from the character image alone on
// Seedance 2.5 reference-to-video (no video_urls), forced to 9:16.
func (s *Service) GenerateI2V(ctx context.Context, personaID string, videoID int64, resolution string, duration int) (Result, error) {
	res := entity.NormalizeResolution(resolution)

	p, err := s.repo.Persona(ctx, personaID)
	if err != nil {
		return Result{}, err
	}

	v, err := s.repo.Video(ctx, personaID, videoID)
	if err != nil {
		return Result{}, err
	}

	prompt := firstNonEmpty(str(v.PromptUsed), str(v.MasterPrompt), str(p.MasterPrompt))
	if prompt == "" {
		return Result{}, ErrNoPrompt
	}

	chars, err := s.repo.PersonaImages(ctx, personaID)
	if err != nil {
		return Result{}, err
	}

	if len(chars) == 0 {
		return Result{}, errors.New("no character image")
	}

	ss := s.newSession()
	defer ss.cleanup()

	s.log("[seedance-ref] uploading %d reference image(s)…", len(chars))

	var imageURLs []string

	for i, rel := range chars {
		local := filepath.Join(s.personasDir, personaID, rel)
		if _, err := os.Stat(local); err != nil {
			s.log("  skip missing: %s", rel)
			continue
		}

		url, err := ss.upload(ctx, local, fmt.Sprintf("%s_i2v_img%d_%s%s", personaID, i+1, ss.stamp, filepath.Ext(local)))
		if err != nil {
			return Result{}, s.fail(ctx, videoID, err)
		}

		imageURLs = append(imageURLs, url)
	}

	if len(imageURLs) == 0 {
		return Result{}, ErrNoImgFile
	}

	dur := entity.I2VDuration(duration)
	body := map[string]any{
		"image_urls": imageURLs, "prompt": prompt, "duration": dur, "resolution": res,
		"aspect_ratio": "9:16", "generate_audio": true, "bitrate_mode": "high",
	}
	s.log("[seedance-ref] submit %s %ds 9:16…", res, dur)
	s.logBody(body, prompt)

	code := strconv.FormatInt(v.ID, 10)
	if v.Shortcode != nil && *v.Shortcode != "" {
		code = *v.Shortcode
	}

	out, err := s.submitAndFinish(ctx, p, videoID, entity.EngineSeedance25, body, "i2v", res, "idea_"+code+"_"+res+".mp4", &prompt)
	if err != nil {
		return Result{}, err
	}

	out.Engine = "seedance-i2v"

	return out, nil
}

// submitAndFinish submits body, records the request id at once (so a poll
// timeout stays recoverable), polls, downloads and records the output.
func (s *Service) submitAndFinish(ctx context.Context, p entity.Persona, videoID int64, eng entity.Engine, body map[string]any,
	idem, resolution, outName string, prompt *string,
) (Result, error) {
	key := s.keys.Key(eng.KeySlot())

	sub, err := s.hf.Submit(ctx, s.baseURL+eng.Path(), key, idem, body)
	if err != nil {
		return Result{}, s.fail(ctx, videoID, err)
	}

	if sub.RequestID == "" {
		return Result{}, s.fail(ctx, videoID, fmt.Errorf("submit failed: %s", truncate(string(sub.Raw), 200)))
	}

	s.log("SUBMITTED request_id=%s status_url=%s", sub.RequestID, sub.StatusURL)

	if err := s.repo.SetRequestID(ctx, videoID, sub.RequestID); err != nil {
		s.log("warning: could not store request id: %v", err)
	}

	st, err := s.hf.Poll(ctx, sub.StatusURL, key)
	if err != nil {
		return Result{}, s.fail(ctx, videoID, err)
	}

	reqID := sub.RequestID

	return s.finish(ctx, p, videoID, st, resolution, outName, prompt, &reqID, false)
}

// finish downloads a completed job and records it; skip-QC personas go
// straight to done and are archived to Drive.
func (s *Service) finish(ctx context.Context, p entity.Persona, videoID int64, st higgsfield.Status, resolution, outName string,
	prompt, reqID *string, clearErr bool,
) (Result, error) {
	if st.Video == nil || st.Video.URL == "" {
		return Result{}, s.fail(ctx, videoID, errors.New("no output url"))
	}

	buf, err := s.hf.Download(ctx, st.Video.URL)
	if err != nil {
		return Result{}, s.fail(ctx, videoID, err)
	}

	rel := filepath.Join("output", resolution, outName)

	dir := filepath.Join(s.personasDir, p.ID, "output", resolution)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return Result{}, fmt.Errorf("creating output dir: %w", err)
	}

	if err := os.WriteFile(filepath.Join(dir, outName), buf, 0o600); err != nil {
		return Result{}, fmt.Errorf("saving output: %w", err)
	}

	stage := entity.StageQC
	if p.SkipQC != nil && *p.SkipQC != 0 {
		stage = entity.StageDone
	}

	if err := s.repo.FinishRender(ctx, entity.RenderDone{
		VideoID: videoID, Column: entity.OutputColumn(resolution), OutputRel: rel,
		Prompt: prompt, RequestID: reqID, Stage: stage, ClearError: clearErr,
	}); err != nil {
		return Result{}, err
	}

	if stage == entity.StageDone && s.archive != nil {
		actx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		if err := s.archive.Archive(actx, p.ID, videoID); err != nil {
			s.log("drive archive failed: %v", err)
		}

		cancel()
	}

	return Result{OK: true, RequestID: str(reqID), Output: rel, SizeMB: fmt.Sprintf("%.2f", float64(len(buf))/1048576)}, nil
}

// Recover re-polls a stored request id and saves its output. It never submits.
func (s *Service) Recover(ctx context.Context, personaID string, videoID int64) (Result, error) {
	p, err := s.repo.Persona(ctx, personaID)
	if err != nil {
		return Result{}, err
	}

	v, err := s.repo.Video(ctx, personaID, videoID)
	if err != nil {
		return Result{}, err
	}

	if v.HFRequestID == nil || *v.HFRequestID == "" {
		return Result{}, s.fail(ctx, videoID, ErrNoRequest)
	}

	reqID := *v.HFRequestID
	statusURL := s.baseURL + "/requests/" + reqID + "/status"

	key := s.ownerKey(ctx, statusURL)
	if key == "" {
		return Result{}, s.fail(ctx, videoID, fmt.Errorf("recover: request %s tidak ditemukan", reqID))
	}

	s.log("recover %s", reqID)

	st, err := s.hf.Poll(ctx, statusURL, key)
	switch {
	case errors.Is(err, higgsfield.ErrPollTimeout):
		return Result{}, s.fail(ctx, videoID, errors.New("poll timeout (render masih jalan, klik Cek Ulang lagi nanti)"))
	case err != nil:
		return Result{}, s.fail(ctx, videoID, err)
	case st.Video == nil || st.Video.URL == "":
		return Result{}, s.fail(ctx, videoID, errors.New("recover: completed tapi tanpa url video"))
	}

	res := p.Resolution()

	out, err := s.finish(ctx, p, videoID, st, res, recoveredName(p, v, res), nil, nil, true)
	if err != nil {
		return Result{}, err
	}

	out.Recovered, out.RequestID = reqID, ""

	return out, nil
}

// ownerKey finds which account owns a request; Seedance's is likelier.
func (s *Service) ownerKey(ctx context.Context, statusURL string) string {
	for _, slot := range []entity.KeySlot{entity.SlotSeedance, entity.SlotWan} {
		k := s.keys.Key(slot)
		if k == "" {
			continue
		}

		if st, err := s.hf.GetStatus(ctx, statusURL, k); err == nil && st.Status != "" && len(st.Detail) == 0 {
			return k
		}
	}

	return ""
}

// recoveredName is the file name the submitting command would have used.
func recoveredName(p entity.Persona, v entity.Video, res string) string {
	if v.LocalRef != nil && *v.LocalRef != "" {
		return fmt.Sprintf("%s_%s_%s.mp4", jsStr(p.ViralClusterSlug), jsStr(v.Shortcode), res)
	}

	return fmt.Sprintf("idea_%s_%s.mp4", firstNonEmpty(str(v.Shortcode), strconv.FormatInt(v.ID, 10)), res)
}

// fail records the error on the video (back to shortlist) and returns it.
func (s *Service) fail(ctx context.Context, videoID int64, err error) error {
	s.log("FAILED: %v", err)

	if dbErr := s.repo.FailRender(context.WithoutCancel(ctx), videoID, err.Error()); dbErr != nil {
		return errors.Join(err, dbErr)
	}

	return err
}

func pickPrompt(p entity.Persona, v entity.Video) string {
	saved := strings.TrimSpace(str(v.PromptUsed))
	if saved == GenericPrompt {
		saved = ""
	}

	return firstNonEmpty(saved, strings.TrimSpace(str(v.MasterPrompt)), strings.TrimSpace(str(p.MasterPrompt)), GenericPrompt)
}

// randomAnimal picks one image from personas/<id>/animals/, if that folder
// exists, as an extra reference so the creature varies per render.
func (s *Service) randomAnimal(personaID string) []string {
	entries, err := os.ReadDir(filepath.Join(s.personasDir, personaID, "animals"))
	if err != nil {
		return nil
	}

	var pool []string

	for _, e := range entries {
		if imageExt.MatchString(e.Name()) {
			pool = append(pool, e.Name())
		}
	}

	if len(pool) == 0 {
		return nil
	}

	pick := pool[s.pick(len(pool))]
	s.log("[random-animal] picked %q from %d in animals/", pick, len(pool))

	return []string{filepath.Join("animals", pick)}
}

// uploadVoices uploads reference voices for audio_mode "ref" personas only.
func (s *Service) uploadVoices(ctx context.Context, ss *session, p entity.Persona) ([]string, error) {
	if str(p.AudioMode) != "ref" || str(p.AudioRef) == "" {
		return nil, nil
	}

	var refs []string
	if err := json.Unmarshal([]byte(*p.AudioRef), &refs); err != nil {
		refs = []string{*p.AudioRef}
	}

	var urls []string

	for i, rel := range refs {
		local := filepath.Join(s.personasDir, p.ID, rel)
		if _, err := os.Stat(local); err != nil {
			continue
		}

		url, err := ss.upload(ctx, local, fmt.Sprintf("%s_voice%d_%s%s", p.ID, i+1, ss.stamp, filepath.Ext(local)))
		if err != nil {
			return nil, err
		}

		urls = append(urls, url)
	}

	return urls, nil
}

func (s *Service) logBody(body map[string]any, prompt string) {
	shown := make(map[string]any, len(body))
	maps.Copy(shown, body)

	shown["prompt"] = fmt.Sprintf("[%d chars]", len([]rune(prompt)))
	b, _ := json.MarshalIndent(shown, "", "  ")
	s.log("REQUEST BODY → %s", b)
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s = strings.TrimSpace(s); s != "" {
			return s
		}
	}

	return ""
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}

	return string(r[:n])
}
