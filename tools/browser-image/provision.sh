#!/bin/sh
set -eu
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive
# Use the same signed Debian archive snapshot on every build.
rm -f /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list
echo 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261002T000000Z/ trixie main' >/etc/apt/sources.list
policy=/usr/sbin/policy-rc.d
if [ -e "$policy" ] || [ -L "$policy" ]; then mv "$policy" "$policy.browser-build"; fi
printf '#!/bin/sh\nexit 101\n' > "$policy"
chmod 0755 "$policy"
apt-get update
apt-get install -y nginx xz-utils curl unzip
tar xJf /opt/worker/node.tar.xz --strip-components=1 -C /usr/local
rm /opt/worker/node.tar.xz
cd /opt/worker
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
export PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
node_modules/.bin/playwright-core install-deps chromium firefox webkit
while read -r digest directory url; do
  curl --fail --silent --show-error --location --retry 2 "$url" -o /tmp/browser.zip
  echo "$digest  /tmp/browser.zip" | sha256sum -c -
  mkdir -p "$PLAYWRIGHT_BROWSERS_PATH/$directory"
  unzip -q /tmp/browser.zip -d "$PLAYWRIGHT_BROWSERS_PATH/$directory"
  touch "$PLAYWRIGHT_BROWSERS_PATH/$directory/INSTALLATION_COMPLETE"
  rm /tmp/browser.zip
done < browsers.lock
node --input-type=module -e "import {chromium,firefox,webkit} from 'playwright-core'; import {accessSync,constants} from 'node:fs'; for(const b of [chromium,firefox,webkit]) accessSync(b.executablePath(),constants.X_OK)"
useradd --system --create-home --home-dir /var/lib/browser --shell /usr/sbin/nologin browser
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin browser-runtime
install -d -m 0700 /etc/canaveral-browser
rm -f /etc/nginx/sites-enabled/default
mv /opt/worker/browser-gateway /etc/nginx/conf.d/browser.conf
mkdir -p /etc/systemd/system/nginx.service.d
printf '[Unit]\nConditionPathExists=/etc/canaveral-browser/fullchain.pem\nConditionPathExists=/etc/canaveral-browser/key.pem\n' >/etc/systemd/system/nginx.service.d/browser.conf
systemctl enable browser.service nginx.service
apt-get clean
rm "$policy"
if [ -e "$policy.browser-build" ] || [ -L "$policy.browser-build" ]; then mv "$policy.browser-build" "$policy"; fi
