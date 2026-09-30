#!/usr/bin/env bash
set -euo pipefail
docker build -t codearena-runtime-python:3.13 runtimes/python
docker build -t codearena-runtime-javascript:22 runtimes/javascript
docker build -t codearena-runtime-typescript:5.8 runtimes/typescript
docker build -t codearena-runtime-c:14 runtimes/c
docker build -t codearena-runtime-cpp:14 runtimes/cpp
docker build -t codearena-runtime-java:21 runtimes/java
docker build -t codearena-runtime-go:1.24 runtimes/go
docker build -t codearena-runtime-rust:1.85 runtimes/rust
