BINARY := vireo-server
GO     := go

.PHONY: all build run test cover lint fmt clean

all: fmt lint test build

## build: compile bin/vireo-server and bin/vireo
build:
	$(GO) build -trimpath -o bin/$(BINARY) ./cmd/server
	$(GO) build -trimpath -o bin/vireo ./cmd/vireo

## run: start the server against ../db/studio.db on 127.0.0.1:4320
run: build
	./bin/$(BINARY)

## test: run every test with the race detector
test:
	$(GO) test -race -count=1 ./...

## cover: test with a coverage summary
cover:
	$(GO) test -race -count=1 -coverprofile=coverage.out ./...
	$(GO) tool cover -func=coverage.out | tail -1

## lint: golangci-lint with the repo config
lint:
	golangci-lint run ./...

## fmt: gofmt + go vet
fmt:
	gofmt -s -w .
	$(GO) vet ./...

clean:
	rm -rf bin/ coverage.out
