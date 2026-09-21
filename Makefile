# Bexio MCP Server — Docker build & GHCR publish
#
# Usage:
#   make build
#   make push                    # requires GHCR_TOKEN
#   make release                 # build + push
#   make installer               # Windows NSIS .exe (build on Linux; needs makensis)
#
# Env:
#   GHCR_TOKEN   GitHub PAT with write:packages (required for push)
#   GHCR_USER    GitHub username or org (default: asig)
#   IMAGE_NAME   image name without registry (default: bexio-mcp-server)
#   TAG          image tag (default: latest)
#   VERSION      optional semver; also used as installer version (default 2.5.0)

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

REGISTRY     ?= ghcr.io
GHCR_USER    ?= asig
IMAGE_NAME   ?= bexio-mcp-server
TAG          ?= latest
VERSION      ?=
NSIS_VERSION ?= $(if $(VERSION),$(VERSION),0.0.1)

IMAGE        := $(REGISTRY)/$(GHCR_USER)/$(IMAGE_NAME)
LOCAL_IMAGE  := $(IMAGE_NAME):$(TAG)

DOCKER       ?= docker
BUILDKIT     ?= 1

NSIS_DIR     := installer/windows
IMAGE_TAR    := $(NSIS_DIR)/bexio-mcp-server-image.tar.gz
NSIS_OUT     := $(NSIS_DIR)/BexioMCPServer-Setup-$(NSIS_VERSION).exe
NSIS_SCRIPT  := $(NSIS_DIR)/bexio-mcp-server.nsi

.PHONY: help build build-no-cache tag login push release run clean print-image \
	image-tar installer windows-installer

help:
	@echo "Targets:"
	@echo "  make build              Build image ($(LOCAL_IMAGE))"
	@echo "  make tag                Tag local image for GHCR ($(IMAGE):$(TAG))"
	@echo "  make login              docker login ghcr.io using GHCR_TOKEN"
	@echo "  make push               Login, tag, and push $(IMAGE):$(TAG)"
	@echo "  make release            build + push"
	@echo "  make run                Run HTTP server on :8000"
	@echo "  make image-tar          Build image and export gzipped docker save"
	@echo "  make installer          Build Windows NSIS installer (needs makensis)"
	@echo "  make windows-installer  Alias for make installer"
	@echo "  make clean              Remove local image tags and installer artifacts"
	@echo ""
	@echo "Variables: GHCR_USER=$(GHCR_USER) IMAGE=$(IMAGE) TAG=$(TAG) VERSION=$(VERSION)"
	@echo "Installer version: NSIS_VERSION=$(NSIS_VERSION) (set VERSION=x.y.z to override)"

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

release: build push

# ---- local run ----

run:
	$(DOCKER) run --rm -p 8000:8000 \
		$(if $(BEXIO_API_TOKEN),-e BEXIO_API_TOKEN=$(BEXIO_API_TOKEN),) \
		$(LOCAL_IMAGE)

clean:
	-$(DOCKER) rmi $(LOCAL_IMAGE) $(IMAGE):$(TAG) $(if $(VERSION),$(IMAGE):$(VERSION),) 2>/dev/null || true
	-rm -f "$(IMAGE_TAR)" "$(NSIS_DIR)"/BexioMCPServer-Setup-*.exe

# ---- Windows NSIS installer (cross-build on Linux) ----
# Requires: sudo apt-get install -y nsis
#
#   make installer
#   make installer VERSION=2.5.1

image-tar: build
	@echo "Exporting $(LOCAL_IMAGE) -> $(IMAGE_TAR)"
	mkdir -p "$(NSIS_DIR)"
	$(DOCKER) save $(LOCAL_IMAGE) | gzip > "$(IMAGE_TAR)"
	@ls -lh "$(IMAGE_TAR)"

installer: image-tar
	@command -v makensis >/dev/null || { \
		echo "error: makensis not found. Install NSIS, e.g.:"; \
		echo "  sudo apt-get install -y nsis"; \
		exit 1; \
	}
	@test -f "$(NSIS_SCRIPT)" || { echo "error: missing $(NSIS_SCRIPT)"; exit 1; }
	@test -f "$(IMAGE_TAR)" || { echo "error: missing $(IMAGE_TAR)"; exit 1; }
	cd "$(NSIS_DIR)" && makensis \
		-DPRODUCT_VERSION=$(NSIS_VERSION) \
		-DIMAGE_NAME=$(LOCAL_IMAGE) \
		-DIMAGE_TAR=bexio-mcp-server-image.tar.gz \
		-DCONTAINER_PORT=8000 \
		-DOUTFILE=BexioMCPServer-Setup-$(NSIS_VERSION).exe \
		bexio-mcp-server.nsi
	@ls -lh "$(NSIS_OUT)"
	@echo "Windows installer ready: $(NSIS_OUT)"

# Alias
windows-installer: installer