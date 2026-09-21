# Bexio MCP Server — Docker build & GHCR publish
#
# Usage:
#   make build
#   make push                    # requires GHCR_TOKEN (and GHCR_USER if not github.actor-style)
#   make release                 # build + push
#
# Env:
#   GHCR_TOKEN   GitHub PAT or token with write:packages (required for push)
#   GHCR_USER    GitHub username or org (default: $(shell git config user.name) is NOT used —
#                set explicitly, or defaults to "asig" matching the fork owner)
#   IMAGE_NAME   image name without registry (default: bexio-mcp-server)
#   TAG          image tag (default: latest)
#   VERSION      optional semver tag also pushed when set (e.g. VERSION=2.5.0)

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

REGISTRY    ?= ghcr.io
GHCR_USER   ?= asig
IMAGE_NAME  ?= bexio-mcp-server
TAG         ?= latest
VERSION     ?=

IMAGE       := $(REGISTRY)/$(GHCR_USER)/$(IMAGE_NAME)
LOCAL_IMAGE := $(IMAGE_NAME):$(TAG)

DOCKER      ?= docker
BUILDKIT    ?= 1

.PHONY: help build build-no-cache tag login push push-version release run clean print-image

help:
	@echo "Targets:"
	@echo "  make build          Build image ($(LOCAL_IMAGE))"
	@echo "  make tag            Tag local image for GHCR ($(IMAGE):$(TAG))"
	@echo "  make login          docker login ghcr.io using GHCR_TOKEN"
	@echo "  make push           Login, tag, and push $(IMAGE):$(TAG)"
	@echo "  make release        build + push"
	@echo "  make run            Run HTTP server on :8000"
	@echo "  make clean          Remove local image tags"
	@echo ""
	@echo "Variables: GHCR_USER=$(GHCR_USER) IMAGE=$(IMAGE) TAG=$(TAG) VERSION=$(VERSION)"

print-image:
	@echo "local=$(LOCAL_IMAGE)"
	@echo "remote=$(IMAGE):$(TAG)"
	@if [ -n "$(VERSION)" ]; then echo "version=$(IMAGE):$(VERSION)"; fi

# ---- build ----

build:
	DOCKER_BUILDKIT=$(BUILDKIT) $(DOCKER) build \
		-t $(LOCAL_IMAGE) \
		-t $(IMAGE):$(TAG) \
		$(if $(VERSION),-t $(IMAGE):$(VERSION),) \
		.

build-no-cache:
	DOCKER_BUILDKIT=$(BUILDKIT) $(DOCKER) build --no-cache \
		-t $(LOCAL_IMAGE) \
		-t $(IMAGE):$(TAG) \
		$(if $(VERSION),-t $(IMAGE):$(VERSION),) \
		.

tag:
	$(DOCKER) tag $(LOCAL_IMAGE) $(IMAGE):$(TAG)
	@if [ -n "$(VERSION)" ]; then $(DOCKER) tag $(LOCAL_IMAGE) $(IMAGE):$(VERSION); fi

# ---- registry ----

login:
	@if [ -z "$${GHCR_TOKEN:-}" ]; then \
		echo "error: GHCR_TOKEN is not set" >&2; \
		exit 1; \
	fi
	@echo "$${GHCR_TOKEN}" | $(DOCKER) login $(REGISTRY) -u "$(GHCR_USER)" --password-stdin

push: login tag
	$(DOCKER) push $(IMAGE):$(TAG)
	@if [ -n "$(VERSION)" ]; then $(DOCKER) push $(IMAGE):$(VERSION); fi
	@echo "Pushed $(IMAGE):$(TAG)"
	@if [ -n "$(VERSION)" ]; then echo "Pushed $(IMAGE):$(VERSION)"; fi

# Build then push in one step
release: build push

# ---- local run ----

run:
	$(DOCKER) run --rm -p 8000:8000 \
		$(if $(BEXIO_API_TOKEN),-e BEXIO_API_TOKEN=$(BEXIO_API_TOKEN),) \
		$(LOCAL_IMAGE)

clean:
	-$(DOCKER) rmi $(LOCAL_IMAGE) $(IMAGE):$(TAG) $(if $(VERSION),$(IMAGE):$(VERSION),) 2>/dev/null || true
