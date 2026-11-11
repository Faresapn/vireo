package apikey_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/apikey"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

const goodKey = "0123abcd-0000-4000-8000-0123456789ab:SecretSecret1234567890"

type fakeStore struct {
	keys     map[entity.KeySlot]entity.APIKey
	replaced int
}

func (f *fakeStore) Read(s entity.KeySlot) (entity.APIKey, error) { return f.keys[s], nil }
func (f *fakeStore) ModTime(entity.KeySlot) (time.Time, bool)     { return time.Unix(0, 0), true }
func (f *fakeStore) Path(s entity.KeySlot) string                 { return "~/" + string(s) }
func (f *fakeStore) Replace(s entity.KeySlot, k entity.APIKey) error {
	f.keys[s] = k
	f.replaced++

	return nil
}

type fakeChecker struct {
	status entity.KeyStatus
	calls  int
}

func (f *fakeChecker) Check(context.Context, entity.APIKey) entity.KeyStatus {
	f.calls++
	return f.status
}

func TestSave(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		slot         entity.KeySlot
		key          string
		check        entity.KeyStatus
		wantErr      error
		wantReplaced int
	}{
		{"valid key is saved", entity.SlotWan, goodKey, entity.KeyValid, nil, 1},
		{"unreachable Higgsfield still saves", entity.SlotSeedance, goodKey, entity.KeyUnknown, nil, 1},
		{"rejected key is not saved", entity.SlotWan, goodKey, entity.KeyInvalid, entity.ErrKeyRejected, 0},
		{"bad format is not checked or saved", entity.SlotWan, "nope", entity.KeyValid, entity.ErrKeyFormat, 0},
		{"unknown slot", "kling", goodKey, entity.KeyValid, entity.ErrUnknownSlot, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			store := &fakeStore{keys: map[entity.KeySlot]entity.APIKey{}}
			svc := apikey.NewService(store, &fakeChecker{status: tt.check})

			info, err := svc.Save(context.Background(), tt.slot, tt.key)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Save() error = %v, want %v", err, tt.wantErr)
			}

			if store.replaced != tt.wantReplaced {
				t.Fatalf("Replace called %d times, want %d", store.replaced, tt.wantReplaced)
			}

			if err == nil && (info.Status != tt.check || !info.Set) {
				t.Fatalf("Save() info = %+v, want set with status %s", info, tt.check)
			}
		})
	}
}

func TestListChecksOnlySetKeys(t *testing.T) {
	t.Parallel()

	store := &fakeStore{keys: map[entity.KeySlot]entity.APIKey{entity.SlotWan: goodKey}}
	checker := &fakeChecker{status: entity.KeyValid}
	svc := apikey.NewService(store, checker)

	keys, err := svc.List(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if len(keys) != 2 || checker.calls != 1 {
		t.Fatalf("got %d keys and %d checks, want 2 keys and 1 check", len(keys), checker.calls)
	}

	if keys[0].Status != entity.KeyValid || keys[1].Set || keys[1].Status != "" {
		t.Fatalf("unexpected list %+v", keys)
	}

	if keys[0].Masked == nil || *keys[0].Masked != "0123abcd…7890" {
		t.Fatalf("masked = %v", keys[0].Masked)
	}
}
