ARG BASE_IMAGE=golang:1.24-bookworm
FROM ${BASE_IMAGE}
# Prebuild only trusted toolchain packages. User source is never part of the image cache.
ENV CGO_ENABLED=0 GOMAXPROCS=2 GOCACHE=/opt/codearena/cache
RUN mkdir -p /opt/codearena /workspace \
    && go list -deps -export -f '{{if .Export}}packagefile {{.ImportPath}}={{.Export}}{{end}}' std > /opt/codearena/importcfg \
    && chown 65532:65532 /workspace
COPY --chmod=0555 compile.sh /usr/local/bin/codearena-go-compile
# Build-time compatibility check for the compiler/linker import map.
RUN mkdir /tmp/compile-check \
    && printf 'package main\nimport "fmt"\nfunc main() { fmt.Println("runtime-ready") }\n' > /tmp/compile-check/main.go \
    && cd /tmp/compile-check && codearena-go-compile && ./main \
    && rm -rf /tmp/compile-check
USER 65532:65532
WORKDIR /workspace
ENV HOME=/workspace TMPDIR=/workspace
CMD ["sleep","infinity"]
