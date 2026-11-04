FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN pip install --no-cache-dir "wsproto>=1.2,<2" "psutil>=6,<8"
COPY canaveral /app/canaveral
ENTRYPOINT ["python", "-m", "canaveral"]

FROM base AS libvirt
RUN apt-get update && apt-get install -y --no-install-recommends libvirt-clients qemu-utils genisoimage openssh-client && rm -rf /var/lib/apt/lists/*

FROM base AS kubevirt
ARG KUBECTL_VERSION=v1.36.2
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openssh-client && \
    curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" && \
    curl -fsSLo /tmp/kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" && \
    echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum --check && \
    chmod 755 /usr/local/bin/kubectl && rm -rf /var/lib/apt/lists/* /tmp/kubectl.sha256

FROM base AS dashboard
RUN useradd --uid 10001 --create-home canaveral
USER 10001:10001
EXPOSE 8766
CMD ["dashboard", "--bind", "0.0.0.0"]

FROM base AS orchestrator
RUN useradd --uid 10001 --create-home canaveral && mkdir /data /run/credentials && chown canaveral /data /run/credentials
USER 10001:10001
EXPOSE 8765
CMD ["serve", "--bind", "0.0.0.0", "--database", "/data/orchestrator.sqlite3", "--admin-token-file", "/run/credentials/admin.token", "--enrollment-token-file", "/run/credentials/enrollment.token"]
