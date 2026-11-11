package prompt_test

import (
	"strings"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/prompt"
)

func TestSanitize(t *testing.T) {
	t.Parallel()

	in := "he kneels clutching the poles tightly against his chest. Then he curls down over the poles, pressing them into his lap. Then he rolls onto his side with the poles beneath him."

	out := prompt.Sanitize(in)
	for _, bad := range []string{"lap", "against his chest", "beneath", "curls down over", "rolls onto his side"} {
		if strings.Contains(out, bad) {
			t.Errorf("%q survived: %s", bad, out)
		}
	}

	if !strings.Contains(out, "falls over sideways and the poles fall beside him") {
		t.Errorf("capture group not substituted: %s", out)
	}

	if got := prompt.Sanitize("a calm walk in the park"); got != "a calm walk in the park" {
		t.Errorf("clean text changed: %q", got)
	}
}

func TestUserText(t *testing.T) {
	t.Parallel()

	slot := prompt.UserText("anatoly", "MASTER", "", false, "")
	if !strings.Contains(slot, "AUTHORITATIVE — reproduce verbatim") || strings.Contains(slot, "(apply this)") {
		t.Fatalf("slot mode text:\n%s", slot)
	}

	story := prompt.UserText("anatoly", "MASTER", "ayam jadi bebek", true, "\nVOICE")
	if !strings.Contains(story, "\nSTORY VARIATION (apply this): ayam jadi bebek\n\nVOICE") {
		t.Fatalf("story text:\n%s", story)
	}

	if strings.Contains(prompt.SystemPrompt(false), "{{SAFE_RULE}}") || !strings.Contains(prompt.SystemPrompt(true), "CONTENT SAFETY") {
		t.Fatal("safety rule must be inlined in both system prompts")
	}
}

func TestPickVariants(t *testing.T) {
	t.Parallel()

	svc := prompt.NewService(nil, nil, nil, "", func(string, ...any) {}, func(n int) int { return n - 1 })

	got := svc.PickVariants("wearing {{a gray tank top| a white t-shirt }} and {{ }} {{solo}}")
	if got != "wearing a white t-shirt and  solo" {
		t.Fatalf("got %q", got)
	}
}
