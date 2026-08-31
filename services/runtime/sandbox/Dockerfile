# services/runtime/sandbox/Dockerfile —— otto-sandbox：工作区沙箱统一镜像
FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ripgrep jq ca-certificates coreutils \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 -s /bin/bash otter || true
WORKDIR /work
CMD ["sleep", "infinity"]
