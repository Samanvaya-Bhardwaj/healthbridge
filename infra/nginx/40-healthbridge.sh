#!/bin/sh
# Start-up configuration for the web container (runs from /docker-entrypoint.d):
#   HB_TLS=on                 TLS server (self-hosted staging/production; certificates
#                             mounted at /etc/nginx/tls)
#   HB_STORAGE_PROXY=off      drop the same-origin MinIO proxy (documents in S3 on AWS)
#   HB_CSP_CONNECT_EXTRA      extra CSP connect-src origins (e.g. the S3 bucket origin)
#   HB_RELOAD_HOURS           reload nginx periodically to pick up renewed certificates
#   HB_MEDIA=on               allow camera/microphone for this origin (live video)
set -eu
conf=/etc/nginx/conf.d/default.conf
snippets=/etc/nginx/snippets

if [ "${HB_TLS:-off}" = "on" ]; then
  if [ ! -s /etc/nginx/tls/fullchain.pem ] || [ ! -s /etc/nginx/tls/privkey.pem ]; then
    echo "HB_TLS=on but /etc/nginx/tls/{fullchain,privkey}.pem are missing" >&2
    exit 1
  fi
  cp /etc/nginx/variants/default.tls.conf "$conf"
  echo "healthbridge: TLS configuration enabled"
fi

if [ "${HB_STORAGE_PROXY:-on}" = "off" ]; then
  sed -i '/# BEGIN storage-proxy/,/# END storage-proxy/d' "$snippets/app.conf"
  echo "healthbridge: document storage proxy disabled"
fi

extra=${HB_CSP_CONNECT_EXTRA:-}
case "$extra" in
  *[!A-Za-z0-9.:/\ _-]*) echo "HB_CSP_CONNECT_EXTRA contains unexpected characters" >&2; exit 1 ;;
esac
sed -i "s#__HB_CSP_CONNECT_EXTRA__#${extra}#" "$snippets/security-headers.conf"

# Camera and microphone stay disabled unless live video is configured.
media='()'
[ "${HB_MEDIA:-off}" = "on" ] && media='(self)'
sed -i "s#__HB_MEDIA_ALLOW__#${media}#g" "$snippets/security-headers.conf"

if [ -n "${HB_RELOAD_HOURS:-}" ]; then
  case "$HB_RELOAD_HOURS" in *[!0-9]*) echo "HB_RELOAD_HOURS must be a number" >&2; exit 1 ;; esac
  # Detached loop; nginx (started next by the entrypoint) keeps running between reloads.
  (while sleep "$((HB_RELOAD_HOURS * 3600))"; do nginx -s reload; done) >/dev/null 2>&1 &
  echo "healthbridge: reloading every ${HB_RELOAD_HOURS} h for certificate renewals"
fi
