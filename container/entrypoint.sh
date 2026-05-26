#!/bin/bash
set -e

CURRENT_UID="$(id -u)"
CURRENT_GID="$(id -g)"
NSS_WRAPPER_LIB="/usr/lib/x86_64-linux-gnu/libnss_wrapper.so"

if ! grep -Eq "^[^:]*:[^:]*:${CURRENT_UID}:${CURRENT_GID}:" /etc/passwd; then
  if [ -f "${NSS_WRAPPER_LIB}" ]; then
    export LD_PRELOAD="${NSS_WRAPPER_LIB}${LD_PRELOAD:+:${LD_PRELOAD}}"
    export NSS_WRAPPER_PASSWD=/tmp/nss-wrapper.passwd
    export NSS_WRAPPER_GROUP=/tmp/nss-wrapper.group

    cp /etc/passwd "${NSS_WRAPPER_PASSWD}"
    cp /etc/group "${NSS_WRAPPER_GROUP}"

    echo "nanoclaw:x:${CURRENT_UID}:${CURRENT_GID}:NanoClaw:${HOME:-/home/node}:/bin/sh" >> "${NSS_WRAPPER_PASSWD}"
    if ! grep -Eq "^[^:]*:[^:]*:${CURRENT_GID}:" /etc/group; then
      echo "nanoclaw:x:${CURRENT_GID}:" >> "${NSS_WRAPPER_GROUP}"
    fi
  fi
fi

exec node /app/dist/index.js
