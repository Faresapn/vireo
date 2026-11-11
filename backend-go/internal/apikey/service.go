package apikey

import (
	"context"
	"fmt"
	"sync"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// Service implements the Settings page use cases.
type Service struct {
	store   Store
	checker Checker
}

// NewService builds a Service.
func NewService(store Store, checker Checker) *Service {
	return &Service{store: store, checker: checker}
}

// List describes every slot. When check is true each set key is verified
// against Higgsfield, in parallel.
func (s *Service) List(ctx context.Context, check bool) ([]entity.KeyInfo, error) {
	out := make([]entity.KeyInfo, len(entity.Slots))

	keys := make([]entity.APIKey, len(entity.Slots))
	for i, slot := range entity.Slots {
		info, key, err := s.describe(slot)
		if err != nil {
			return nil, err
		}

		out[i], keys[i] = info, key
	}

	if !check {
		return out, nil
	}

	var wg sync.WaitGroup

	for i := range out {
		if !out[i].Set {
			continue
		}

		wg.Go(func() { out[i].Status = s.checker.Check(ctx, keys[i]) })
	}

	wg.Wait()

	return out, nil
}

// Save validates raw and, unless Higgsfield rejects it, stores it in slot.
// A key Higgsfield could not be reached for is still saved, with status unknown.
func (s *Service) Save(ctx context.Context, slot entity.KeySlot, raw string) (entity.KeyInfo, error) {
	if !slot.Valid() {
		return entity.KeyInfo{}, entity.ErrUnknownSlot
	}

	key, err := entity.ParseAPIKey(raw)
	if err != nil {
		return entity.KeyInfo{}, err
	}

	status := s.checker.Check(ctx, key)
	if status == entity.KeyInvalid {
		return entity.KeyInfo{}, entity.ErrKeyRejected
	}

	if err := s.store.Replace(slot, key); err != nil {
		return entity.KeyInfo{}, fmt.Errorf("saving %s key: %w", slot, err)
	}

	info, _, err := s.describe(slot)
	if err != nil {
		return entity.KeyInfo{}, err
	}

	info.Status = status

	return info, nil
}

func (s *Service) describe(slot entity.KeySlot) (entity.KeyInfo, entity.APIKey, error) {
	key, err := s.store.Read(slot)
	if err != nil {
		return entity.KeyInfo{}, "", fmt.Errorf("reading %s key: %w", slot, err)
	}

	info := entity.KeyInfo{
		Slot:    slot,
		File:    s.store.Path(slot),
		Engines: slot.Engines(),
		Set:     key != "",
	}
	if key != "" {
		m := key.Masked()
		info.Masked = &m
	}

	if t, ok := s.store.ModTime(slot); ok {
		info.Updated = &t
	}

	return info, key, nil
}
