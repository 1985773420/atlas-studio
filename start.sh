#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
umask 077
# .env 是 shell 配置，只加载自己的可信文件；值含空格时请加引号。
if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi
exec "${PYTHON:-python3}" -I backend/server.py
