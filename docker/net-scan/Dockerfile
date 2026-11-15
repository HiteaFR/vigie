# ARP companion of Vigie: net-scan (agent/net-scan) every 120 s, in network_mode: host, with the
# single NET_RAW capability (docker-compose.yml, "arp" profile). Local build only, no published
# image: arp-scan is under the GPL (v3 or later), a published image would have to provide its
# sources.
#
# Base: Debian bookworm slim, pinned by dated tag AND by digest of the multi-architecture index
# (read on 2026-11-11 from the Docker Hub registry: Docker-Content-Digest header of
# debian:bookworm-20261104-slim, equal to the sha256 of the received body and to the digest of the
# hub.docker.com API).
#
# User: root INSIDE the container, with no capability other than NET_RAW (cap_drop: ALL,
# no-new-privileges, read-only file system). Reason: Docker gives no ambient capabilities to a
# non-root user, and a file capability on arp-scan would be canceled by no-new-privileges. The
# written file belongs to root, directory 0755: the server (uid 1000) reads it and refuses any
# file it would own (readArp).
FROM debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update \
  && apt-get install -y --no-install-recommends arp-scan \
  && rm -rf /var/lib/apt/lists/*
COPY agent/net-scan/net-scan /usr/local/sbin/net-scan
COPY docker/net-scan/loop.sh /usr/local/sbin/net-scan-loop
RUN chmod 755 /usr/local/sbin/net-scan /usr/local/sbin/net-scan-loop \
  && install -d -m 0755 /run/net-scan
ENTRYPOINT ["/usr/local/sbin/net-scan-loop"]
