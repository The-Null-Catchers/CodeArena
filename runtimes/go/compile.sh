#!/bin/sh
set -eu
# Single-file, standard-library-only v1 runtime. Inputs/outputs are fixed registry paths.
# Trusted standard packages are baked into the read-only image, never a shared writable cache.
export GOMAXPROCS=1 CGO_ENABLED=0
/usr/local/go/bin/go tool compile -p main -importcfg /opt/codearena/importcfg -o main.a main.go
exec /usr/local/go/bin/go tool link -importcfg /opt/codearena/importcfg -o main main.a
