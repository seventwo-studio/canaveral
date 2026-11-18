#!/bin/bash
set -euo pipefail
umask 077
trap 'systemctl --no-block poweroff' EXIT
echo credentials > /root/trial/result
cd /etc/canaveral-browser
openssl rand -hex 32 > token
echo https://127.0.0.1 > origin
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=trial-ca \
  -keyout ca.key -out ca.pem -addext basicConstraints=critical,CA:TRUE
openssl req -new -newkey rsa:2048 -nodes -subj /CN=localhost -keyout key.pem -out tls.csr
echo 'subjectAltName=IP:127.0.0.1' > extensions
openssl x509 -req -in tls.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 \
  -extfile extensions -out fullchain.pem
echo startup > /root/trial/result
systemctl start browser.service nginx.service
for attempt in {1..60}; do
  if [[ $(curl -s --cacert ca.pem -o /dev/null -w '%{http_code}' https://127.0.0.1/v1/browsers) == 403 ]]; then break; fi
  sleep 1
done
echo session > /root/trial/result
NODE_EXTRA_CA_CERTS="$PWD/ca.pem" /usr/local/bin/node /opt/worker/trial.mjs
echo isolation > /root/trial/result
bash /root/trial/isolation.sh
echo passed > /root/trial/result
