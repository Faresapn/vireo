package archive_test

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/archive"
)

type fakeRepo struct {
	persona archive.Persona
	video   archive.Video
	used    []string

	syncedID   int64
	syncedName *string
}

func (f *fakeRepo) Persona(context.Context, string) (archive.Persona, error) { return f.persona, nil }

func (f *fakeRepo) Video(context.Context, string, int64) (archive.Video, error) {
	return f.video, nil
}

func (f *fakeRepo) DriveNames(context.Context, string, string) ([]string, error) { return f.used, nil }

func (f *fakeRepo) MarkSynced(_ context.Context, id int64, name *string) error {
	f.syncedID, f.syncedName = id, name
	return nil
}

type upload struct{ local, remote, folder string }

type fakeUploader struct {
	calls []upload
	err   error
}

func (f *fakeUploader) Copy(_ context.Context, local, remote, folder string) error {
	f.calls = append(f.calls, upload{local, remote, folder})
	return f.err
}

type fakeFiles map[string]bool

func (f fakeFiles) Exists(p string) bool { return f[p] }

var day = func() time.Time { return time.Date(2026, 11, 11, 10, 0, 0, 0, time.Local) }

const (
	root  = "/studio/personas"
	denvo = "Denvo"
)

func TestPersonaFolderNamesByDayAndBatch(t *testing.T) {
	t.Parallel()

	repo := &fakeRepo{
		persona: archive.Persona{ID: "kepin-kids", Name: denvo, DriveFolderID: new("FOLDER")},
		video:   archive.Video{ID: 7, Output480: new("output/480p/a.mp4"), Output1080: new("output/720p/a.mp4")},
		used:    []string{"11-11-2026_Denvo_1.mp4", "11-11-2026_Denvo_2.mp4"},
	}
	up := &fakeUploader{}
	files := fakeFiles{filepath.Join(root, "kepin-kids/output/720p/a.mp4"): true}

	res, err := archive.NewService(repo, up, files, root, day).Archive(context.Background(), "kepin-kids", 7, false)
	if err != nil {
		t.Fatal(err)
	}

	want := []upload{{filepath.Join(root, "kepin-kids/output/720p/a.mp4"), "11-11-2026_Denvo_3.mp4", "FOLDER"}}
	if !reflect.DeepEqual(up.calls, want) {
		t.Fatalf("uploads = %+v, want %+v", up.calls, want)
	}

	if repo.syncedID != 7 || repo.syncedName == nil || *repo.syncedName != "11-11-2026_Denvo_3.mp4" {
		t.Fatalf("MarkSynced(%d, %v)", repo.syncedID, repo.syncedName)
	}

	if res.Folder != "FOLDER" || res.Uploaded[0] != "11-11-2026_Denvo_3.mp4" {
		t.Fatalf("result = %+v", res)
	}
}

func TestReArchiveKeepsItsName(t *testing.T) {
	t.Parallel()

	repo := &fakeRepo{
		persona: archive.Persona{ID: "p", Name: denvo, DriveFolderID: new("F")},
		video:   archive.Video{ID: 1, Output480: new("o.mp4"), DriveName: new("01-01-2026_Denvo_4.mp4")},
		used:    []string{"11-11-2026_Denvo_1.mp4"},
	}
	up := &fakeUploader{}

	_, err := archive.NewService(repo, up, fakeFiles{filepath.Join(root, "p/o.mp4"): true}, root, day).
		Archive(context.Background(), "p", 1, false)
	if err != nil {
		t.Fatal(err)
	}

	if up.calls[0].remote != "01-01-2026_Denvo_4.mp4" {
		t.Fatalf("remote = %q, want the stored name", up.calls[0].remote)
	}
}

func TestPersonaFolderWithoutOutputFails(t *testing.T) {
	t.Parallel()

	repo := &fakeRepo{
		persona: archive.Persona{ID: "p", Name: "X", DriveFolderID: new("F")},
		video:   archive.Video{ID: 1, Output480: new("gone.mp4")},
	}
	up := &fakeUploader{}

	_, err := archive.NewService(repo, up, fakeFiles{}, root, day).Archive(context.Background(), "p", 1, false)
	if !errors.Is(err, archive.ErrOutputMissing) || len(up.calls) != 0 || repo.syncedID != 0 {
		t.Fatalf("err = %v, uploads = %d, synced = %d", err, len(up.calls), repo.syncedID)
	}
}

func TestStudioTreeUploadsOutputAndReference(t *testing.T) {
	t.Parallel()

	repo := &fakeRepo{
		persona: archive.Persona{ID: "p", Name: "P", ViralClusterSlug: new("anatoly")},
		video:   archive.Video{ID: 3, Output480: new("out/v.mp4"), LocalRef: new("refs/r.mp4")},
	}
	up := &fakeUploader{}
	files := fakeFiles{filepath.Join(root, "p/out/v.mp4"): true, filepath.Join(root, "p/refs/r.mp4"): true}

	res, err := archive.NewService(repo, up, files, root, day).Archive(context.Background(), "p", 3, false)
	if err != nil {
		t.Fatal(err)
	}

	wantRemote := []string{"HiggsfieldStudio/anatoly/output/480p/v.mp4", "HiggsfieldStudio/anatoly/references/r.mp4"}
	for i, c := range up.calls {
		if c.remote != wantRemote[i] || c.folder != "" {
			t.Fatalf("upload %d = %+v, want remote %s in root", i, c, wantRemote[i])
		}
	}

	if !reflect.DeepEqual(res.Uploaded, []string{"output/480p/v.mp4", "references/r.mp4"}) || res.Slug != "anatoly" {
		t.Fatalf("result = %+v", res)
	}

	if repo.syncedID != 3 || repo.syncedName != nil {
		t.Fatal("studio-tree archive must mark synced without a drive name")
	}
}

func TestDryRunTouchesNothing(t *testing.T) {
	t.Parallel()

	repo := &fakeRepo{
		persona: archive.Persona{ID: "p", Name: denvo, DriveFolderID: new("F")},
		video:   archive.Video{ID: 1, Output480: new("o.mp4")},
	}
	up := &fakeUploader{}

	res, err := archive.NewService(repo, up, fakeFiles{filepath.Join(root, "p/o.mp4"): true}, root, day).
		Archive(context.Background(), "p", 1, true)
	if err != nil {
		t.Fatal(err)
	}

	if len(up.calls) != 0 || repo.syncedID != 0 || !res.DryRun || res.Uploaded[0] != "11-11-2026_Denvo_1.mp4" {
		t.Fatalf("dry run uploaded %d, synced %d, result %+v", len(up.calls), repo.syncedID, res)
	}
}

func TestUploadErrorDoesNotMarkSynced(t *testing.T) {
	t.Parallel()

	repo := &fakeRepo{
		persona: archive.Persona{ID: "p", Name: denvo, DriveFolderID: new("F")},
		video:   archive.Video{ID: 1, Output480: new("o.mp4")},
	}
	boom := errors.New("403 insufficientParentPermissions")

	_, err := archive.NewService(repo, &fakeUploader{err: boom}, fakeFiles{filepath.Join(root, "p/o.mp4"): true}, root, day).
		Archive(context.Background(), "p", 1, false)
	if !errors.Is(err, boom) || repo.syncedID != 0 {
		t.Fatalf("err = %v, synced = %d", err, repo.syncedID)
	}
}
