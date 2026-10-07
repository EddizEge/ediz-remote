FROM selenium/standalone-chrome@sha256:18c17c7d95c29f21966ad6151c64aa1a3bf661c575a09f58d33c4bf2e5c66568

USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends iproute2 \
    && rm -rf /var/lib/apt/lists/*
USER 1200
