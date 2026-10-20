#!/bin/bash
# Auto-start Vireo dashboard (production build preferred; dev fallback).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd /Users/brankosutisyo/Documents/higgsfield-studio/dashboard || exit 1

# Use production build if present, else dev.
if [ -d .next ] && [ -f .next/BUILD_ID ]; then
  exec npm run start -- -p 4319
else
  exec npm run dev
fi
