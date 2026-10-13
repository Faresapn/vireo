# R2 transit config — set these in your environment or a local .env (never commit real values)
# R2 is used only as a short-lived public-URL relay for the generation APIs.
R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-media}"
R2_PREFIX="${R2_PREFIX:-higgsfield-transit}"
R2_CDN="${R2_CDN:-https://your-r2-cdn.example.com}"
R2_FLAGS="--s3-no-check-bucket"
