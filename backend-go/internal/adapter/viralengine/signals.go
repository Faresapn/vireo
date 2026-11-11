package viralengine

import (
	"context"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
	"github.com/Faresapn/vireo/backend-go/internal/ingest"
)

// Signals implements ingest.Signals with the list_instagram_signals tool.
type Signals struct {
	Client *Client
}

// List returns one page of a cluster's posts.
func (s Signals) List(ctx context.Context, cluster string, order entity.IngestOrder, limit, offset int) (ingest.Cluster, bool, error) {
	var out struct {
		Clusters []ingest.Cluster `json:"clusters"`
	}

	err := s.Client.Call(ctx, "list_instagram_signals", map[string]any{
		"cluster": cluster, "order": string(order), "limit": limit, "offset": offset,
	}, &out)
	if err != nil {
		return ingest.Cluster{}, false, err
	}

	if len(out.Clusters) == 0 {
		return ingest.Cluster{}, false, nil
	}

	return out.Clusters[0], true, nil
}
