ARG BASE_IMAGE=eclipse-temurin:21-jdk-jammy
FROM ${BASE_IMAGE}

RUN mkdir -p /workspace && chown 65532:65532 /workspace
USER 65532:65532
WORKDIR /workspace
ENV HOME=/workspace TMPDIR=/workspace
CMD ["sleep","infinity"]
