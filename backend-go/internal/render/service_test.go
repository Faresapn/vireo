package render_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/higgsfield"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
	"github.com/Faresapn/vireo/backend-go/internal/render"
)

type fakeRepo struct {
	persona entity.Persona
	video   entity.Video
	images  []string
	reqID   string
	failMsg string
	done    *entity.RenderDone
}

func (f *fakeRepo) Persona(context.Context, string) (entity.Persona, error) { return f.persona, nil }

func (f *fakeRepo) Video(context.Context, string, int64) (entity.Video, error) {
	return f.video, nil
}

func (f *fakeRepo) CharacterImages(context.Context, string, int64) ([]string, error) {
	return f.images, nil
}
func (f *fakeRepo) PersonaImages(context.Context, string) ([]string, error) { return f.images, nil }
func (f *fakeRepo) SetRequestID(_ context.Context, _ int64, id string) error {
	f.reqID = id
	return nil
}

func (f *fakeRepo) FailRender(_ context.Context, _ int64, msg string) error {
	f.failMsg = msg
	return nil
}

func (f *fakeRepo) FinishRender(_ context.Context, d entity.RenderDone) error {
	f.done = &d
	return nil
}

type fakeTransit struct {
	uploaded, deleted []string
}

func (f *fakeTransit) Upload(_ context.Context, _, name string) (string, error) {
	f.uploaded = append(f.uploaded, name)
	return "https://cdn/" + name, nil
}
func (f *fakeTransit) Delete(_ context.Context, name string) { f.deleted = append(f.deleted, name) }

type fakeMedia struct{ seconds float64 }

func (fakeMedia) PrepareRef(_ context.Context, src string, _ func(string, ...any)) (string, bool) {
	return src, false
}

func (fakeMedia) DownscaleImage(_ context.Context, src string, _ int, _ func(string, ...any)) (string, bool) {
	return src, false
}
func (m fakeMedia) VideoSeconds(context.Context, string) float64 { return m.seconds }

type fakeHF struct {
	endpoint, key string
	body          map[string]any
	pollErr       error
	submitNoID    bool
}

func (f *fakeHF) Submit(_ context.Context, endpoint, key, _ string, body any) (higgsfield.Submission, error) {
	f.endpoint, f.key = endpoint, key

	f.body, _ = body.(map[string]any)
	if f.submitNoID {
		return higgsfield.Submission{Raw: []byte(`{"detail":"Not enough credits"}`)}, nil
	}

	return higgsfield.Submission{RequestID: "req-1", StatusURL: "status"}, nil
}

func (f *fakeHF) Poll(context.Context, string, string) (higgsfield.Status, error) {
	if f.pollErr != nil {
		return higgsfield.Status{}, f.pollErr
	}

	st := higgsfield.Status{Status: "completed"}
	st.Video = &struct {
		URL string `json:"url"`
	}{URL: "https://out/v.mp4"}

	return st, nil
}

func (f *fakeHF) GetStatus(context.Context, string, string) (higgsfield.Status, error) {
	return higgsfield.Status{Status: "in_progress"}, nil
}

func (f *fakeHF) Download(context.Context, string) ([]byte, error) { return []byte("video-bytes"), nil }

type keys map[entity.KeySlot]string

func (k keys) Key(s entity.KeySlot) string { return k[s] }

type fakeArchive struct{ calls int }

func (f *fakeArchive) Archive(context.Context, string, int64) error { f.calls++; return nil }

//go:fix inline

func setup(t *testing.T, skipQC int64) (*render.Service, *fakeRepo, *fakeTransit, *fakeHF, *fakeArchive, string) {
	t.Helper()

	dir := t.TempDir()
	for _, f := range []string{"p/refs/r.mp4", "p/char/c1.jpg", "p/char/c2.jpg"} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, f)), 0o750); err != nil {
			t.Fatal(err)
		}

		if err := os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	repo := &fakeRepo{
		persona: entity.Persona{ID: "p", ViralClusterSlug: new("anatoly"), SkipQC: &skipQC, MasterPrompt: new("MASTER")},
		video:   entity.Video{ID: 9, Shortcode: new("ABC"), LocalRef: new("refs/r.mp4"), PromptUsed: new("VISION PROMPT")},
		images:  []string{"char/c1.jpg", "char/missing.jpg", "char/c2.jpg"},
	}
	tr, hf, arch := &fakeTransit{}, &fakeHF{}, &fakeArchive{}
	svc := render.NewService(render.Config{
		Repo: repo, Transit: tr, Media: fakeMedia{seconds: 9.2}, Higgsfield: hf,
		Keys: keys{entity.SlotWan: "KEY-A", entity.SlotSeedance: "KEY-B"}, Archive: arch,
		PersonasDir: dir, BaseURL: "https://hf", Now: func() time.Time { return time.UnixMilli(0) },
	})

	return svc, repo, tr, hf, arch, dir
}

func TestGenerateSeedanceFlow(t *testing.T) {
	t.Parallel()
	svc, repo, tr, hf, arch, dir := setup(t, 0)

	res, err := svc.Generate(context.Background(), "p", 9, entity.EngineSeedance, "720p", 0)
	if err != nil {
		t.Fatal(err)
	}
	// "seedance" renders on 2.5 with the second key.
	if hf.endpoint != "https://hf/bytedance/seedance-2.5/reference-to-video" || hf.key != "KEY-B" {
		t.Fatalf("submitted to %s with %s", hf.endpoint, hf.key)
	}
	// 9.2s ref → ceil-1 = 9s, strictly below the source.
	if hf.body["duration"] != 9 || hf.body["prompt"] != "VISION PROMPT" || hf.body["aspect_ratio"] != "9:16" {
		t.Fatalf("body = %v", hf.body)
	}

	imgs, ok := hf.body["image_urls"].([]string)
	if !ok || len(imgs) != 2 || imgs[0] != "https://cdn/p_char1_0.jpg" || imgs[1] != "https://cdn/p_char3_0.jpg" {
		t.Fatalf("image urls = %v (missing file skipped, numbering kept)", imgs)
	}

	if repo.reqID != "req-1" {
		t.Fatal("request id must be stored right after submit")
	}

	if repo.done == nil || repo.done.Stage != entity.StageQC || repo.done.Column != "output_1080" ||
		repo.done.OutputRel != "output/720p/anatoly_ABC_720p.mp4" || *repo.done.Prompt != "VISION PROMPT" {
		t.Fatalf("finish = %+v", repo.done)
	}

	if b, _ := os.ReadFile(filepath.Join(dir, "p", repo.done.OutputRel)); string(b) != "video-bytes" { //nolint:gosec // test temp dir
		t.Fatalf("output file = %q", b)
	}

	if arch.calls != 0 {
		t.Fatal("QC personas are not archived")
	}

	if len(tr.deleted) != len(tr.uploaded) || len(tr.uploaded) != 3 {
		t.Fatalf("transit uploaded %v, deleted %v", tr.uploaded, tr.deleted)
	}

	if res.Engine != "seedance" || res.RequestID != "req-1" || res.SizeMB != "0.00" {
		t.Fatalf("result = %+v", res)
	}
}

func TestGenerateWanUsesFirstKeyAndArchivesSkipQC(t *testing.T) {
	t.Parallel()

	svc, repo, _, hf, arch, _ := setup(t, 1)
	if _, err := svc.Generate(context.Background(), "p", 9, entity.EngineWanPrime, "480p", 0); err != nil {
		t.Fatal(err)
	}

	if hf.key != "KEY-A" || hf.body["resolution"] != "480p" {
		t.Fatalf("key %s body %v", hf.key, hf.body)
	}

	if repo.done.Stage != entity.StageDone || repo.done.Column != "output_480" || arch.calls != 1 {
		t.Fatalf("skip-QC persona: finish %+v, archive calls %d", repo.done, arch.calls)
	}
}

func TestGenerateFailureGoesBackToShortlistAndCleansUp(t *testing.T) {
	t.Parallel()
	svc, repo, tr, hf, _, _ := setup(t, 0)
	hf.pollErr = &higgsfield.JobError{Status: "nsfw", Reason: "content safety"}

	_, err := svc.Generate(context.Background(), "p", 9, entity.EngineSeedance, "720p", 0)

	var je *higgsfield.JobError
	if !errors.As(err, &je) || repo.failMsg != "nsfw: content safety" || repo.done != nil {
		t.Fatalf("err %v, fail %q, done %+v", err, repo.failMsg, repo.done)
	}

	if len(tr.deleted) != len(tr.uploaded) {
		t.Fatal("transit files must be deleted on failure")
	}
}

func TestSubmitWithoutRequestIDFails(t *testing.T) {
	t.Parallel()
	svc, repo, _, hf, _, _ := setup(t, 0)
	hf.submitNoID = true

	_, err := svc.Generate(context.Background(), "p", 9, entity.EngineSeedance, "720p", 0)
	if err == nil || repo.reqID != "" || repo.failMsg == "" {
		t.Fatalf("err %v, reqID %q, fail %q", err, repo.reqID, repo.failMsg)
	}
}

func TestGenericPromptNeverShadowsMaster(t *testing.T) {
	t.Parallel()
	svc, repo, _, hf, _, _ := setup(t, 0)
	repo.video.PromptUsed = new(render.GenericPrompt)

	if _, err := svc.Generate(context.Background(), "p", 9, entity.EngineSeedance, "720p", 0); err != nil {
		t.Fatal(err)
	}

	if hf.body["prompt"] != "MASTER" {
		t.Fatalf("prompt = %v", hf.body["prompt"])
	}
}

func TestGenerateI2V(t *testing.T) {
	t.Parallel()
	svc, repo, _, hf, _, _ := setup(t, 0)
	repo.video.LocalRef = nil
	repo.video.Shortcode = new("idea123")

	res, err := svc.GenerateI2V(context.Background(), "p", 9, "720p", 15)
	if err != nil {
		t.Fatal(err)
	}

	if _, hasVideo := hf.body["video_urls"]; hasVideo || hf.body["duration"] != 14 || hf.key != "KEY-B" {
		t.Fatalf("body %v key %s (no video_urls, odd 15 → 14, Seedance key)", hf.body, hf.key)
	}

	if res.Engine != "seedance-i2v" || repo.done.OutputRel != "output/720p/idea_idea123_720p.mp4" {
		t.Fatalf("result %+v finish %+v", res, repo.done)
	}
}

func TestRecoverNeverSubmits(t *testing.T) {
	t.Parallel()
	svc, repo, _, hf, _, _ := setup(t, 0)
	repo.video.HFRequestID = new("req-old")
	repo.persona.RenderRes = new("480p")

	res, err := svc.Recover(context.Background(), "p", 9)
	if err != nil {
		t.Fatal(err)
	}

	if hf.endpoint != "" {
		t.Fatal("recover must not submit a new render")
	}

	if res.Recovered != "req-old" || repo.done.OutputRel != "output/480p/anatoly_ABC_480p.mp4" || !repo.done.ClearError {
		t.Fatalf("result %+v finish %+v", res, repo.done)
	}
}

func TestRecoverWithoutRequestID(t *testing.T) {
	t.Parallel()

	svc, repo, _, _, _, _ := setup(t, 0)
	if _, err := svc.Recover(context.Background(), "p", 9); !errors.Is(err, render.ErrNoRequest) || repo.failMsg == "" {
		t.Fatalf("err %v fail %q", err, repo.failMsg)
	}
}
