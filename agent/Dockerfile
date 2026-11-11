# 构建：docker build -f agent/Dockerfile -t yunzou-agent agent
# 运行：docker run --rm -e DATABASE_URL -v /opt/yunzou/plugins:/opt/yunzou/plugins:ro yunzou-agent
FROM golang:1.26-bookworm AS build
WORKDIR /source
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/yunzou-agent .

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /opt/yunzou
COPY --from=build /out/yunzou-agent /opt/yunzou/agent
COPY plugins /opt/yunzou/plugins
USER nonroot:nonroot
ENTRYPOINT ["/opt/yunzou/agent", "--plugins", "/opt/yunzou/plugins"]
