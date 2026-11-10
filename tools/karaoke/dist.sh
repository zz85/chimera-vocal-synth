#!/bin/sh
# Build the app into dist/ with relative paths, then link the Lakh MIDI Dataset and its index
# into dist/shows/karaoke/ (they are too big to copy). LAKH defaults to ~/test/lakh, which holds
# lmd_full/ and lakh-index.tsv (bun tools/karaoke/lakh-index.ts writes it).
set -e
cd "$(dirname "$0")/../.."
LAKH="${LAKH:-$HOME/test/lakh}"
npx vite build --base=./
ln -sfn "$LAKH/lmd_full" dist/shows/karaoke/lakh
ln -sfn "$LAKH/lakh-index.tsv" dist/shows/karaoke/lakh-index.tsv
echo "dist/shows/karaoke/lakh -> $LAKH/lmd_full"
