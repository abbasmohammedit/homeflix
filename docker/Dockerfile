FROM ubuntu:24.04

# Path of the .deb, relative to the repository root (the build context).
ARG DEB=packages/HOMEFLIX-1.4.1+plus7-linux-amd64.deb
ENV DEBIAN_FRONTEND=noninteractive

# Install the HOMEFLIX .deb; apt pulls in all of its declared dependencies.
COPY ${DEB} /tmp/homeflix.deb
RUN apt-get update \
    && apt-get install -y --no-install-recommends /tmp/homeflix.deb ca-certificates \
    && rm -rf /var/lib/apt/lists/* /tmp/homeflix.deb

COPY docker/start.js /app/start.js

# Run unprivileged as UID 1000 (the image's built-in "ubuntu" user, usually your own UID too).
RUN mkdir -p /videos /cache /data /config \
    && chown -R 1000:1000 /cache /data
USER 1000:1000

# Use the Electron binary as plain Node: no display or GPU needed.
ENV ELECTRON_RUN_AS_NODE=1
EXPOSE 8080
VOLUME ["/cache", "/data"]
CMD ["/opt/HOMEFLIX/homeflix", "/app/start.js"]
