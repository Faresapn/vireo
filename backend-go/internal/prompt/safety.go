package prompt

import "regexp"

// The video engine rejects prompts whose wording reads as sexual even when the
// clip is innocent. The LLM is told to avoid such words (prompts/safe_rule.txt)
// and Sanitize rewrites the usual triggers afterwards.
var safeSwaps = []struct {
	re  *regexp.Regexp
	rep string
}{
	{regexp.MustCompile(`(?i)\b(?:into|onto|on|in|across|over) (?:his|her|their) lap\b`), "toward the floor"},
	{regexp.MustCompile(`(?i)\b(?:his|her|their) lap\b`), "the floor"},
	{regexp.MustCompile(`(?i)\b(?:crotch|groin|between (?:his|her|their) legs|between the legs)\b`), "in front of the body"},
	{regexp.MustCompile(`(?i)\b(?:thighs?|buttocks?|butt|hips)\b`), "legs"},
	{regexp.MustCompile(`(?i)\bcurls? down over\b`), "leans down toward"},
	{regexp.MustCompile(`(?i)\b(?:pressed |held |clutch\w* )?(?:tight(?:ly)? )?against (?:(?:his|her|their) (?:chest|body|belly)|himself|herself|themselves)\b`), "upright in front of him"},
	{regexp.MustCompile(`(?i)\bpress(?:es|ing)? (?:them|it) (?:into|against)\b`), "pushes them toward"},
	{regexp.MustCompile(`(?i)\b(?:rubs?|rubbing|grinds?|grinding|thrusts?|thrusting|straddl\w*|strok\w*|caress\w*|writh\w*|moan\w*)\b`), "moves"},
	{regexp.MustCompile(`(?i)\brolls? onto (?:his|her|their) side\b`), "falls over sideways"},
	{regexp.MustCompile(`(?i)\bwith the ([\w\s-]{1,30}?) (?:beneath|under|underneath) (?:him|her|them)\b`), "and the ${1} fall beside him"},
	{regexp.MustCompile(`(?i)\b(?:beneath|underneath) (?:him|her|them)\b`), "beside him"},
	{regexp.MustCompile(`(?i)\b(?:shafts?|rods?)\b`), "bats"},
}

// Sanitize rewrites wording that trips the engine's content filter.
func Sanitize(text string) string {
	for _, s := range safeSwaps {
		text = s.re.ReplaceAllString(text, s.rep)
	}

	return text
}
