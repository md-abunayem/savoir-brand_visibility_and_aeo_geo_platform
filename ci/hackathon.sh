#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
[[ $GITHUB_REF == refs/heads/main && $GITHUB_RUN_ATTEMPT == 1 ]]
[[ $GITHUB_REPOSITORY == md-abunayem/savoir-brand_visibility_and_aeo_geo_platform ]]
[[ $FIELDNOTE_NETWORK == standard-runner-approved ]]
[[ $STAGE =~ ^(network-check|account-check|hack-title|hack-faq-before|hack-faq-after)$ ]]
export CASE_WORK
CASE_WORK=$(mktemp -d "$RUNNER_TEMP/fieldnote.XXXXXXXX")
if [[ $STAGE == hack-* ]]; then node ci/cloud.mjs prepare "$STAGE"; fi

root=/opt/fieldnote
sudo install -d -m 755 "$root"
sudo cp -R "$RUNNER_TEMP/fieldnote-tools" "$root/tools"
sudo cp -R ci fixture.mjs case.mjs "$root/"
sudo chmod -R a+rX "$root"
sudo useradd --system --user-group --home-dir /var/lib/fieldnote-cli --shell /usr/sbin/nologin fieldcli
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin fieldweb
sudo install -d -o fieldcli -g fieldcli -m 700 /var/lib/fieldnote-cli
node_bin=$(realpath "$(command -v node)")
unit=(-p "WorkingDirectory=$root" -p ProtectHome=yes -p ProtectSystem=strict
  -p ProtectProc=invisible -p PrivateDevices=yes -p PrivateTmp=yes -p NoNewPrivileges=yes
  -p LimitCORE=0 -p UMask=0077 -p MemoryMax=1500M -p CPUQuota=100% -p TasksMax=192
  -p RuntimeMaxSec=6min -p 'InaccessiblePaths=-/run/docker.sock -/run/containerd -/run/dbus -/run/user -/run/systemd/private'
  --setenv="PATH=$(dirname "$node_bin"):/usr/bin:/bin")
cli=("${unit[@]}" -p User=fieldcli -p ReadWritePaths=/var/lib/fieldnote-cli --setenv=HOME=/var/lib/fieldnote-cli)
web=("${unit[@]}" -p User=fieldweb -p IPAddressDeny=any -p IPAddressAllow=localhost --setenv=HOME=/tmp)
run=(sudo systemd-run --quiet --wait --pipe)
trap 'sudo systemctl stop field-browser.service field-fixture.service 2>/dev/null || true' EXIT
sudo systemd-run --quiet --unit=field-fixture "${web[@]}" "$node_bin" "$root/fixture.mjs" initial
# Probe the same reachable IPv4 endpoint from both identities to distinguish filtering from an outage.
provider_ip=$("${run[@]}" "${cli[@]}" python3 -c 'import socket,ssl; h="auth.lambdatest.com"; ip=socket.gethostbyname(h); s=socket.create_connection((ip,443),timeout=8); ssl.create_default_context().wrap_socket(s,server_hostname=h).close(); print(ip)')
"${run[@]}" "${web[@]}" python3 - "$provider_ip" <<'PY'
import errno, socket, sys
with socket.socket() as sock:
    sock.settimeout(4)
    try:
        code = sock.connect_ex((sys.argv[1], 443))
    except TimeoutError:
        code = errno.ETIMEDOUT
    assert code in (errno.EPERM, errno.EACCES, errno.ETIMEDOUT, errno.EAGAIN), "Unexpected browser egress result"
PY
"${run[@]}" "${web[@]}" /bin/bash -eu -c '
  google-chrome --headless --allow-chrome-scheme-url --user-data-dir=/tmp/status-profile --dump-dom chrome://sandbox > /tmp/status
  sed -E "s/<[^>]+>/ /g" /tmp/status | tr "\n" " " | tr -s " " > /tmp/text
  grep -Eiq "Seccomp-BPF sandbox Yes" /tmp/text
  grep -Eiq "(PID namespaces|SUID sandbox) Yes" /tmp/text
  curl --noproxy "*" -fsS http://127.0.0.1:4318/ | grep -F "<title>Fieldnote Seed Library</title>" >/dev/null
' 2>/dev/null
"${run[@]}" "${cli[@]}" "$node_bin" "$root/tools/node_modules/@testmuai/kane-cli/bin/kane-cli.cjs" --version | grep -Fxq '0.10.9'
if [[ $STAGE == network-check ]]; then echo "CLI TLS, loopback fixture, browser egress denial and sandbox checks passed."; exit 0; fi

node -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify([process.env.LT_USERNAME,process.env.LT_ACCESS_KEY]),{mode:0o600})' "$CASE_WORK/login"
"${run[@]}" "${cli[@]}" -p "LoadCredential=login:$CASE_WORK/login" "$node_bin" ci/cloud.mjs identity "$STAGE" > "$CASE_WORK/identity"
if [[ $STAGE == account-check ]]; then
  node --input-type=module -e 'import {readFile,writeFile} from "node:fs/promises"; import {seal} from "./case.mjs"; const record=JSON.parse(await readFile(process.env.CASE_WORK+"/identity")); await writeFile(process.env.RUNNER_TEMP+"/fieldnote.case",seal({stage:"account",...record}),{flag:"wx",mode:0o600})'
  exit 0
fi
sudo systemd-run --quiet --unit=field-browser "${web[@]}" /usr/bin/google-chrome --headless --disable-background-networking --user-data-dir=/tmp/browser --remote-debugging-port=4319 about:blank
"${run[@]}" "${cli[@]}" "$node_bin" --input-type=module -e '
  for(let i=0;i<30;i++){try{const r=await fetch("http://127.0.0.1:4319/json/version");if((await r.json()).Browser.startsWith("Chrome/"))process.exit(0)}catch{}await new Promise(r=>setTimeout(r,300))}process.exit(1)'
node ci/cloud.mjs admission "$STAGE"
"${run[@]}" "${cli[@]}" "$node_bin" ci/cloud.mjs launch "$STAGE" > "$CASE_WORK/terminal" || true
node ci/cloud.mjs settle "$STAGE"
