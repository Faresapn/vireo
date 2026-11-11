package main

import (
	"path/filepath"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/viralengine"
)

type signals = viralengine.Signals

func viralEngine(name string) (*viralengine.Client, error) {
	return viralengine.NewFromTokenFile(filepath.Join(home(), ".viralengine_token"), name)
}
