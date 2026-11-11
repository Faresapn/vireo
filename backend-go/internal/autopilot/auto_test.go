package autopilot_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/autopilot"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

//go:fix inline

type repo struct {
	persona   entity.Persona
	inbox     []entity.Video
	stages    map[int64]entity.Stage
	penalized []int64
	daily     []entity.Persona
	status    map[string]string
	last      map[string]string
	genErr    string
}

func newRepo() *repo {
	return &repo{stages: map[int64]entity.Stage{}, status: map[string]string{}, last: map[string]string{}}
}

func (r *repo) Persona(context.Context, string) (entity.Persona, error) { return r.persona, nil }
func (r *repo) Inbox(context.Context, string) ([]entity.Video, error) {
	var out []entity.Video

	for _, v := range r.inbox {
		if s, ok := r.stages[v.ID]; !ok || s == entity.StageInbox {
			out = append(out, v)
		}
	}

	return out, nil
}

func (r *repo) InboxCount(ctx context.Context, id string) (int, error) {
	v, _ := r.Inbox(ctx, id)
	return len(v), nil
}
func (r *repo) OKDurationStats(context.Context, string) (float64, int, error) { return 0, 0, nil }
func (r *repo) RAGStats(context.Context, string) (entity.RAGStats, error) {
	return entity.RAGStats{}, nil
}
func (r *repo) BestEngine(context.Context, string) (entity.Engine, error) { return "", nil }
func (r *repo) SetStage(_ context.Context, id int64, s entity.Stage) error {
	r.stages[id] = s
	return nil
}

func (r *repo) PenalizeRef(_ context.Context, id int64) error {
	r.penalized = append(r.penalized, id)

	r.stages[id] = entity.StageInbox
	for i := range r.inbox {
		if r.inbox[i].ID == id {
			r.inbox[i].RefScore = new(int64(20))
		}
	}

	return nil
}

func (r *repo) MarkDone(_ context.Context, id int64) error {
	r.stages[id] = entity.StageDone
	return nil
}

func (r *repo) VideoStage(_ context.Context, id int64) (entity.Stage, error) {
	return r.stages[id], nil
}
func (r *repo) DailyPersonas(context.Context) ([]entity.Persona, error) { return r.daily, nil }
func (r *repo) SetDailyLast(_ context.Context, id, d string) error      { r.last[id] = d; return nil }

func (r *repo) SetDailyStatus(_ context.Context, id, s string) error { r.status[id] = s; return nil }

func (r *repo) StartRender(context.Context, int64, entity.Engine) error {
	return nil
}

func (r *repo) ResetStuckRender(context.Context, int64, string) (string, error) {
	return r.genErr, nil
}

type steps struct {
	r          *repo
	screen     map[int64]int
	genFail    map[int64]bool
	generated  []int64
	screened   []int64
	ideas      int
	i2vFail    int
	autoResult autopilot.AutoResult
}

func (s *steps) Ingest(context.Context, string, int, entity.IngestOrder) error { return nil }
func (s *steps) Screen(_ context.Context, _ string, id int64) (int, string, string, error) {
	s.screened = append(s.screened, id)

	sc, ok := s.screen[id]
	if !ok {
		return 0, "", "", errors.New("vision down")
	}

	return sc, "x", "y", nil
}
func (s *steps) BuildPrompt(context.Context, string, int64, string) error { return nil }
func (s *steps) Generate(_ context.Context, _ string, id int64, _ entity.Engine, _ string) error {
	s.generated = append(s.generated, id)
	if s.genFail[id] {
		return errors.New("nsfw")
	}

	s.r.stages[id] = entity.StageDone

	return nil
}
func (s *steps) Archive(context.Context, string, int64) error { return nil }
func (s *steps) Idea(context.Context, string) (int64, string, error) {
	s.ideas++
	return int64(100 + s.ideas), "idea", nil
}

func (s *steps) GenerateI2V(context.Context, string, int64, string, int, string) error {
	if s.i2vFail > 0 {
		s.i2vFail--
		return errors.New("exit 1")
	}

	return nil
}

func (s *steps) Auto(context.Context, string, autopilot.AutoOptions) (autopilot.AutoResult, error) {
	return s.autoResult, nil
}

func vid(id int64, vph, dur float64, order string) entity.Video {
	return entity.Video{ID: id, Shortcode: new(fmt.Sprintf("c%d", id)), ViewsPerHour: &vph, DurationS: &dur, IngestOrder: &order}
}

func quiet(string, ...any) {}

func TestPickRefPrefersSuitabilityOverVelocity(t *testing.T) {
	t.Parallel()

	r := newRepo()
	r.inbox = []entity.Video{vid(1, 1000, 10, "date"), vid(2, 100, 10, "date"), vid(3, 50, 40, "date")}
	st := &steps{r: r, screen: map[int64]int{1: 30, 2: 90}}
	svc := autopilot.NewService(r, st, quiet)

	ref, err := svc.PickRef(context.Background(), entity.Persona{ID: "x"}, map[int64]bool{}, entity.OrderDate, 27)
	if err != nil || ref == nil || ref.ID != 2 {
		t.Fatalf("picked %+v, %v: want 2 (1 scored below 45, 3 longer than max-dur)", ref, err)
	}

	if len(st.screened) != 2 {
		t.Fatalf("screened %v: the over-long ref must be filtered before screening", st.screened)
	}
}

func TestPickRefFallsBackFromNarrowedOrder(t *testing.T) {
	t.Parallel()

	r := newRepo()
	r.inbox = []entity.Video{vid(1, 10, 10, "date"), vid(2, 5, 10, "velocity")}
	svc := autopilot.NewService(r, &steps{r: r, screen: map[int64]int{1: 10, 2: 80}}, quiet)

	ref, _ := svc.PickRef(context.Background(), entity.Persona{ID: "x"}, map[int64]bool{}, entity.OrderDate, 0)
	if ref == nil || ref.ID != 2 {
		t.Fatalf("picked %+v: the newest refs were all bad, so the rest of the inbox counts", ref)
	}
}

func TestAutoTriesAnotherRefAfterFailedRender(t *testing.T) {
	t.Parallel()

	r := newRepo()
	r.persona = entity.Persona{ID: "x", AutoEngine: new("wan-prime")}
	r.inbox = []entity.Video{vid(1, 100, 10, "date"), vid(2, 50, 10, "date")}
	st := &steps{r: r, screen: map[int64]int{1: 90, 2: 80}, genFail: map[int64]bool{1: true}}

	res, err := autopilot.NewService(r, st, quiet).Auto(context.Background(), "x", autopilot.AutoOptions{Count: 1})
	if err != nil {
		t.Fatal(err)
	}

	got := res.Results[0]
	if !got.OK || got.Shortcode != "c2" || got.Engine != "wan-prime" || got.Stage != "done" {
		t.Fatalf("result %+v", got)
	}

	if len(r.penalized) != 1 || r.penalized[0] != 1 {
		t.Fatalf("penalized %v, want the failed ref", r.penalized)
	}
}

func TestPickEngine(t *testing.T) {
	t.Parallel()

	svc := autopilot.NewService(newRepo(), &steps{}, quiet)

	tests := []struct {
		caption string
		dur     float64
		want    entity.Engine
	}{
		{"singa lucu", 20, entity.EngineSeedance25},
		{"cat", 20, entity.EngineGenjutsu},
		{"a TIGER", 10, entity.EngineSeedance},
		{"cat", 10, entity.EngineSeedance},
	}
	for _, tt := range tests {
		if got, _ := svc.PickEngine(context.Background(), "n", tt.caption, tt.dur); got != tt.want {
			t.Errorf("PickEngine(%q, %v) = %s, want %s", tt.caption, tt.dur, got, tt.want)
		}
	}
}

func TestDailyRetriesSafetyBlockOnceWithFreshIdea(t *testing.T) {
	t.Parallel()

	r := newRepo()
	r.genErr = "nsfw: content safety restrictions"
	r.daily = []entity.Persona{{ID: "idea-p", MasterPrompt: new("AUTO_DURATION: 14\nx"), SkipQC: new(int64(1))}}
	st := &steps{r: r, i2vFail: 1}
	now := func() time.Time { return time.Date(2026, 11, 11, 11, 0, 0, 0, time.Local) }

	d := autopilot.NewDaily(autopilot.NewService(r, st, quiet), now, t.TempDir(), func(string) {})
	if err := d.Run(context.Background(), false); err != nil {
		t.Fatal(err)
	}

	if st.ideas != 2 || !strings.Contains(r.status["idea-p"], "OK, video 102 masuk HASIL") || r.last["idea-p"] != "2026-11-11" {
		t.Fatalf("ideas %d, status %q, last %q", st.ideas, r.status["idea-p"], r.last["idea-p"])
	}
}

func TestDailySkipsDoneTodayAndMissingDuration(t *testing.T) {
	t.Parallel()

	r := newRepo()
	r.daily = []entity.Persona{
		{ID: "ran", DailyAutoLast: new("2026-11-11"), MasterPrompt: new("AUTO_DURATION: 10")},
		{ID: "nodur", MasterPrompt: new("no duration line")},
	}
	st := &steps{r: r}
	now := func() time.Time { return time.Date(2026, 11, 11, 11, 0, 0, 0, time.Local) }

	var lines []string

	d := autopilot.NewDaily(autopilot.NewService(r, st, quiet), now, t.TempDir(), func(s string) { lines = append(lines, s) })
	if err := d.Run(context.Background(), true); err != nil {
		t.Fatal(err)
	}

	if len(lines) != 1 || lines[0] != "nodur idea 720p NO AUTO_DURATIONs" {
		t.Fatalf("dry-run lines %q", lines)
	}

	if err := d.Run(context.Background(), false); err != nil {
		t.Fatal(err)
	}

	if st.ideas != 0 || !strings.Contains(r.status["nodur"], "dilewati") {
		t.Fatalf("ideas %d status %q", st.ideas, r.status["nodur"])
	}
}

func TestMasterDuration(t *testing.T) {
	t.Parallel()

	if autopilot.MasterDuration("x\nAUTO_DURATION: 14\ny") != 14 || autopilot.MasterDuration("AUTO_DURATION: soon") != 0 {
		t.Fatal("MasterDuration")
	}
}
