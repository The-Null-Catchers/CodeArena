FROM golang:1.25.1-bookworm AS build
# Build upstream source instead of relying on withdrawn prebuilt image tags.
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
WORKDIR /src
RUN git init . && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth 1 origin ${MINIO_COMMIT} \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${MINIO_COMMIT}"
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -o /out/minio .
FROM debian:bookworm-slim
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /src/LICENSE /licenses/minio/LICENSE
RUN mkdir /data && chown 65532:65532 /data
USER 65532:65532
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
