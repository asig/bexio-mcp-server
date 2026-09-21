# Bexio OAuth Bridge — Docker build & GHCR publish
#
# Usage:
#   make build
#   make run
#   make push          # needs GHCR_TOKEN
#   make release       # build + push
#
# Env:
#   GHCR_TOKEN   PAT with write:packages
#   GHCR_USER    GitHub user/org (default: asig)
#   TAG          image tag (default: latest)
#   VERSION      optional extra tag

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

REGISTRY    ?= ghcr.io
GHCR_USER   ?= asig
IMAGE_NAME  ?= bexio-oauth-bridge
TAG         ?= latest
VERSION     ?=

IMAGE       := $(REGISTRY)/$(GHCR_USER)/$(IMAGE_NAME)
LOCAL_IMAGE := $(IMAGE_NAME):$(TAG)

DOCKER      ?= docker
BUILDKIT    ?= 1
PORT        ?= 3100

.PHONY: help build build-no-cache tag login push release run run-env clean print-image

help:
	@echo "Targets:"
	@echo "  make build       Build image ($(LOCAL_IMAGE))"
	@echo "  make run         Run on :$(PORT) (pass env via .env or RUN_ENV)"
	@echo "  make run-env     Run with --env-file .env and data volume"
	@echo "  make push        Login, tag, push to $(IMAGE):$(TAG)"
	@echo "  make release     build + push"
	@echo "  make clean       Remove local image tags"
	@echo ""
	@echo "Variables: GHCR_USER=$(GHCR_USER) TAG=$(TAG) VERSION=$(VERSION) PORT=$(PORT)"

print-image:
	@echo "local=$(LOCAL_IMAGE)"
	@echo "remote=$(IMAGE):$(TAG)"

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

release: build push

# Minimal run — required secrets must be in the environment
run:
	$(DOCKER) run --rm -p $(PORT):3100 \
		-e PORT=3100 \
		-e HOST=0.0.0.0 \
		$(if $(BEXIO_CLIENT_ID),-e BEXIO_CLIENT_ID=$(BEXIO_CLIENT_ID),) \
		$(if $(BEXIO_CLIENT_SECRET),-e BEXIO_CLIENT_SECRET=$(BEXIO_CLIENT_SECRET),) \
		$(if $(BEXIO_REDIRECT_URI),-e BEXIO_REDIRECT_URI=$(BEXIO_REDIRECT_URI),) \
		$(if $(PUBLIC_BASE_URL),-e PUBLIC_BASE_URL=$(PUBLIC_BASE_URL),) \
		$(if $(TOKEN_ENCRYPTION_KEY),-e TOKEN_ENCRYPTION_KEY=$(TOKEN_ENCRYPTION_KEY),) \
		$(LOCAL_IMAGE)

# Recommended local run: .env + persistent volume
run-env:
	@test -f .env || { echo "error: create .env from .env.example first"; exit 1; }
	$(DOCKER) run --rm -p $(PORT):3100 \
		--env-file .env \
		-v bexio-oauth-bridge-data:/app/data \
		$(LOCAL_IMAGE)

clean:
	-$(DOCKER) rmi $(LOCAL_IMAGE) $(IMAGE):$(TAG) $(if $(VERSION),$(IMAGE):$(VERSION),) 2>/dev/null || true
