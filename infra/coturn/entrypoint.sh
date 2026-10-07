#!/bin/sh
set -eu

fail() {
  echo "coturn configuration error: $1" >&2
  exit 1
}

inline_secret="${TURN_SHARED_SECRET:-}"
secret_file="${TURN_SHARED_SECRET_FILE:-}"
realm="${TURN_REALM:-}"
min_port="${TURN_MIN_PORT:-49160}"
max_port="${TURN_MAX_PORT:-49200}"
external_ip="${TURN_EXTERNAL_IP:-}"
relay_ip="${TURN_RELAY_IP:-}"
test_mode="${TURN_TEST_MODE:-false}"
log_level="${TURN_LOG_LEVEL:-warning}"
log_output="${TURN_LOG_OUTPUT:-}"

if [ -n "$inline_secret" ] && [ -n "$secret_file" ]; then
  fail "TURN secret yalnızca tek bir kaynaktan verilmelidir."
fi

if [ -n "$secret_file" ]; then
  [ ! -L "$secret_file" ] && [ -f "$secret_file" ] && [ -r "$secret_file" ] ||
    fail "TURN secret dosyası güvenli ve okunabilir olmalıdır."
  secret_owner="$(stat -c '%u:%g' -- "$secret_file" 2>/dev/null || true)"
  [ "$secret_owner" = "$(id -u):$(id -g)" ] ||
    fail "TURN secret dosyası doğru kullanıcıya ait olmalıdır."
  secret_mode="$(stat -c '%a' -- "$secret_file" 2>/dev/null || true)"
  case "$secret_mode" in
    400|600) ;;
    *) fail "TURN secret dosyası izinleri özel olmalıdır." ;;
  esac
  secret_size="$(wc -c < "$secret_file" | tr -d '[:space:]')"
  case "$secret_size" in
    ''|*[!0-9]*) fail "TURN secret dosyası boyutu doğrulanamadı." ;;
  esac
  [ "$secret_size" -le 4096 ] || fail "TURN secret dosyası 4096 baytı aşamaz."
  secret="$(cat "$secret_file")"
else
  secret="$inline_secret"
fi

unset TURN_SHARED_SECRET TURN_SHARED_SECRET_FILE inline_secret secret_file secret_size secret_owner secret_mode

if [ -z "$log_output" ]; then
  if [ "$test_mode" = "true" ]; then
    log_output="stdout"
  else
    log_output="discard"
  fi
fi

[ "${#secret}" -ge 32 ] ||
  fail "TURN_SHARED_SECRET en az 32 karakter olmalıdır."
[ "${#secret}" -le 4096 ] ||
  fail "TURN_SHARED_SECRET 4096 karakteri aşamaz."
[ "$secret" != "replace-with-a-long-random-secret" ] ||
  fail "örnek TURN_SHARED_SECRET üretimde kullanılamaz."
case "$secret" in
  *[!A-Za-z0-9_+/=-]*) fail "TURN_SHARED_SECRET yalnızca güvenli Base64 karakterleri içerebilir." ;;
esac
[ -n "$realm" ] || fail "TURN_REALM zorunludur."
[ "${#realm}" -le 253 ] || fail "TURN_REALM 253 karakteri aşamaz."

case "$realm" in
  *[!A-Za-z0-9.-]*) fail "TURN_REALM yalnızca harf, rakam, nokta ve tire içerebilir." ;;
esac
case "$min_port:$max_port" in
  *[!0-9:]*|:*|*:) fail "TURN_MIN_PORT ve TURN_MAX_PORT sayı olmalıdır." ;;
esac
case "$log_level" in
  warning|info|debug) ;;
  *) fail "TURN_LOG_LEVEL warning, info veya debug olmalıdır." ;;
esac
case "$log_output" in
  discard|stdout) ;;
  *) fail "TURN_LOG_OUTPUT yalnızca discard veya stdout olabilir." ;;
esac
[ "$min_port" -ge 1024 ] || fail "TURN_MIN_PORT en az 1024 olmalıdır."
[ "$max_port" -le 65535 ] || fail "TURN_MAX_PORT en fazla 65535 olmalıdır."
[ "$min_port" -le "$max_port" ] ||
  fail "TURN_MIN_PORT, TURN_MAX_PORT değerinden büyük olamaz."

is_ipv4() {
  echo "$1" | awk -F. '
    NF != 4 { exit 1 }
    {
      for (i = 1; i <= 4; i++) {
        if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1
      }
    }
  '
}

if [ "$test_mode" != "true" ]; then
  [ -n "$external_ip" ] ||
    fail "üretimde TURN_EXTERNAL_IP veya 'auto' değeri zorunludur."
  [ -n "$relay_ip" ] || fail "üretimde TURN_RELAY_IP zorunludur."
  if [ "$external_ip" = "auto" ]; then
    external_ip="$(detect-external-ip)"
  fi
  is_ipv4 "$external_ip" || fail "TURN_EXTERNAL_IP geçerli bir IPv4 olmalıdır."
  is_ipv4 "$relay_ip" || fail "TURN_RELAY_IP geçerli bir IPv4 olmalıdır."
fi

config_file="/tmp/ediz-remote-turnserver.conf"
umask 077
{
  echo "listening-port=3478"
  echo "min-port=$min_port"
  echo "max-port=$max_port"
  echo "realm=$realm"
  echo "server-name=$realm"
  echo "fingerprint"
  echo "lt-cred-mech"
  echo "use-auth-secret"
  printf 'static-auth-secret=%s\n' "$secret"
  echo "stale-nonce=600"
  echo "max-allocate-lifetime=3600"
  echo "user-quota=12"
  echo "total-quota=32"
  echo "max-bps=16000000"
  echo "bps-capacity=100000000"
  echo "no-cli"
  echo "no-tls"
  echo "no-dtls"
  echo "no-tcp-relay"
  echo "no-multicast-peers"
  echo "no-rfc5780"
  echo "no-dynamic-ip-list"
  echo "no-dynamic-realms"
  echo "prometheus"
  echo "prometheus-address=127.0.0.1"
  echo "pidfile=/tmp/turnserver.pid"
  echo "simple-log"
  echo "log-min-level=$log_level"
  if [ "$log_output" = "stdout" ]; then
    echo "log-file=/dev/stdout"
  else
    echo "no-stdout-log"
    echo "log-file=/dev/null"
  fi
  if [ "$log_level" = "debug" ]; then
    echo "verbose"
    echo "log-binding"
  fi
  if [ -n "$relay_ip" ]; then
    echo "listening-ip=$relay_ip"
    echo "relay-ip=$relay_ip"
  fi
  if [ -n "$external_ip" ]; then
    if [ -z "$relay_ip" ] || [ "$external_ip" = "$relay_ip" ]; then
      echo "external-ip=$external_ip"
    else
      echo "external-ip=$external_ip/$relay_ip"
    fi
  fi
  if [ "${TURN_ALLOW_PRIVATE_PEERS:-false}" != "true" ]; then
    echo "denied-peer-ip=0.0.0.0-0.255.255.255"
    echo "denied-peer-ip=10.0.0.0-10.255.255.255"
    echo "denied-peer-ip=100.64.0.0-100.127.255.255"
    echo "denied-peer-ip=127.0.0.0-127.255.255.255"
    echo "denied-peer-ip=169.254.0.0-169.254.255.255"
    echo "denied-peer-ip=172.16.0.0-172.31.255.255"
    echo "denied-peer-ip=192.168.0.0-192.168.255.255"
    echo "denied-peer-ip=224.0.0.0-255.255.255.255"
  fi
} > "$config_file"

unset secret

exec turnserver \
  -c "$config_file" \
  --pidfile=/tmp/turnserver.pid \
  --no-tls \
  --no-dtls
