FROM coturn/coturn:4.17.0-r0-alpine@sha256:8f80ed9d6867319340ca612b9d005aaea2444755aa4ce3dd79ddfb5f31f6e1b5

USER root
RUN apk upgrade --no-cache && apk add --no-cache libcap && setcap -r /usr/bin/turnserver && apk del libcap

COPY --chmod=0555 entrypoint.sh /etc/ediz-remote/entrypoint.sh

USER 1000:1000
ENTRYPOINT ["/bin/sh", "/etc/ediz-remote/entrypoint.sh"]
