#!/usr/bin/env bash
set -euo pipefail
umask 077
trap 'printf "Runner check stopped at line %s (exit %s)\n" "$LINENO" "$?" >&2' ERR
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${GITHUB_RUN_ATTEMPT:-} == 1 ]]
[[ $GITHUB_REPOSITORY == md-abunayem/savoir-brand_visibility_and_aeo_geo_platform && $GITHUB_REF == refs/heads/main ]]
[[ $STAGE =~ ^(qualify|account|title|dev-title|faq-before|faq-after)$ ]]
export CASE_WORK
CASE_WORK=$(mktemp -d "$RUNNER_TEMP/fieldnote.XXXXXXXX")
live=false
revision=initial
if [[ $STAGE != qualify && $STAGE != account ]]; then
  live=true
  [[ -n $UPLOAD_HOST && -n $LT_USERNAME && -n $LT_ACCESS_KEY ]]
  node ci/cloud.mjs prepare "$STAGE"
  if [[ $STAGE == faq-after ]]; then revision=approved; fi
fi
root=/opt/fieldnote
net=fieldnote
sudo install -d -m 755 "$root"
sudo cp -R "$RUNNER_TEMP/fieldnote-tools" "$root/tools"
sudo cp -R fixture.mjs case.mjs ci "$root/"
sudo chmod -R a+rX "$root"
sudo useradd --system --user-group --home-dir /var/lib/fieldnote-cli --shell /usr/sbin/nologin fieldcli
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin fieldweb
sudo install -d -o fieldcli -g fieldcli -m 700 /var/lib/fieldnote-cli
sudo mount -t tmpfs -o "size=256m,mode=0700,uid=$(id -u fieldcli),gid=$(id -g fieldcli)" tmpfs /var/lib/fieldnote-cli
sudo ip netns add "$net"
trap 'sudo systemctl stop field-browser.service field-fixture.service 2>/dev/null || true' EXIT
sudo ip link add field-uplink type veth peer name field-guest
sudo ip link set field-guest netns "$net"
sudo ip addr add 192.0.2.1/30 dev field-uplink
sudo ip link set field-uplink up
sudo ip -n "$net" addr add 192.0.2.2/30 dev field-guest
sudo ip -n "$net" link set field-guest up
sudo ip -n "$net" link set lo up
[[ -z $(sudo ip -n "$net" route show default) ]]
# Only the TLS gateway can receive packets from the namespace. Block IPv6 and all forwarding.
sudo nft -f - <<'NFT'
table inet fieldnote {
  chain ingress {
    type filter hook input priority -100; policy accept;
    iifname "field-uplink" ip daddr 192.0.2.1 tcp dport 443 accept
    iifname "field-uplink" drop
  }
  chain transit {
    type filter hook forward priority -100; policy accept;
    iifname "field-uplink" drop
  }
}
NFT
export GATEWAY_CONFIG="$CASE_WORK/gateway.cfg" NAME_MAP="$CASE_WORK/hosts"
python3 - <<'PY'
import ipaddress, os, re, socket
from pathlib import Path
names=['auth.lambdatest.com','kaneai-api.lambdatest.com','test-manager-api.lambdatest.com']
extra=os.environ.get('UPLOAD_HOST')
if extra:
    assert len(extra)<=253 and all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', s) for s in extra.split('.')) and '.' in extra
    names.append(extra)
lines=['global','  maxconn 32','defaults','  mode tcp','  timeout connect 6s','  timeout client 180s','  timeout server 180s',
       'frontend gate','  bind 192.0.2.1:443','  tcp-request inspect-delay 4s',
       '  acl permitted req.ssl_sni -i '+' '.join(names),
       '  tcp-request content accept if { req.ssl_hello_type 1 } permitted',
       '  tcp-request content reject if { req.ssl_hello_type 1 }','  tcp-request content reject if WAIT_END']
for n,name in enumerate(names):
    lines.append(f'  use_backend dst{n} if {{ req.ssl_sni -i {name} }}')
for n,name in enumerate(names):
    ips=socket.getaddrinfo(name,443,socket.AF_INET,socket.SOCK_STREAM)
    assert ips and all(ipaddress.ip_address(i[4][0]).is_global for i in ips)
    lines.extend([f'backend dst{n}',f'  server origin {ips[0][4][0]}:443'])
Path(os.environ['GATEWAY_CONFIG']).write_text('\n'.join(lines)+'\n')
Path(os.environ['NAME_MAP']).write_text('127.0.0.1 localhost\n'+'\n'.join('192.0.2.1 '+n for n in names)+'\n')
PY
sudo haproxy -c -f "$GATEWAY_CONFIG"
sudo haproxy -D -f "$GATEWAY_CONFIG"
sudo install -m 644 "$NAME_MAP" "$root/hosts"
sudo install -m 644 /dev/null "$root/no-dns"
node_bin=$(realpath "$(command -v node)")
unit=(-p "WorkingDirectory=$root" -p "NetworkNamespacePath=/run/netns/$net"
  -p "BindReadOnlyPaths=$root/hosts:/etc/hosts $root/no-dns:/etc/resolv.conf"
  -p ProtectHome=yes -p ProtectSystem=strict -p ProtectProc=invisible -p PrivateDevices=yes
  -p NoNewPrivileges=yes -p LimitCORE=0 -p UMask=0077 -p MemoryMax=1500M -p CPUQuota=100% -p TasksMax=192
  -p RuntimeMaxSec=10min -p 'TemporaryFileSystem=/tmp:size=256M,mode=1777'
  -p 'InaccessiblePaths=-/run/docker.sock -/run/containerd -/run/dbus -/run/user -/run/systemd/resolve/io.systemd.Resolve -/run/systemd/private -/run/nscd'
  --setenv="PATH=$(dirname "$node_bin"):/usr/bin:/bin")
web=("${unit[@]}" -p User=fieldweb --setenv=HOME=/tmp)
cli=("${unit[@]}" -p User=fieldcli -p ReadWritePaths=/var/lib/fieldnote-cli --setenv=HOME=/var/lib/fieldnote-cli)
sudo systemd-run --quiet --unit=field-fixture "${web[@]}" "$node_bin" "$root/fixture.mjs" "$revision"
sudo systemd-run --quiet --pipe --wait "${cli[@]}" python3 - <<'PY'
import errno, os, socket, ssl
from pathlib import Path
assert os.getuid()!=0 and not os.access('/run/docker.sock',os.R_OK) and not os.access('/home/runner',os.R_OK)
assert not os.access('/opt/fieldnote/ci/cloud.mjs',os.W_OK)
cg=Path('/sys/fs/cgroup') / Path(Path('/proc/self/cgroup').read_text().strip().split('::')[1]).relative_to('/')
quota,period=map(int,(cg/'cpu.max').read_text().split())
assert 0<quota<=period and int((cg/'memory.max').read_text())<=1500*1024**2 and int((cg/'pids.max').read_text())<=192
for line in Path('/etc/hosts').read_text().splitlines()[1:]:
    name=line.split()[1]
    with socket.create_connection((name,443),timeout=6) as conn:
        with ssl.create_default_context().wrap_socket(conn,server_hostname=name): pass
try: socket.create_connection(('1.1.1.1',443),timeout=2)
except OSError as exc: assert exc.errno in (errno.ENETUNREACH,errno.EHOSTUNREACH)
else: raise RuntimeError('Unexpected public route')
try:
    with socket.create_connection(('192.0.2.1',443),timeout=6) as conn:
        ssl.create_default_context().wrap_socket(conn,server_hostname='unrelated.invalid')
except (ssl.SSLEOFError,ConnectionResetError): pass
else: raise RuntimeError('Unexpected SNI acceptance')
PY
echo "Restricted identity, filesystem, cgroup and TLS probes passed"
sudo systemd-run --quiet --wait --pipe "${web[@]}" /bin/bash -eu -c '
  echo "Inspecting headless Chrome sandbox status"
  google-chrome --headless --allow-chrome-scheme-url --disable-background-networking --user-data-dir=/tmp/profile --dump-dom chrome://sandbox > /tmp/status
  sed -E "s/<[^>]+>/ /g" /tmp/status | tr "\n" " " | tr -s " " > /tmp/text
  echo "Checking renderer seccomp"
  grep -Eiq "Seccomp-BPF sandbox Yes" /tmp/text
  echo "Checking renderer namespace"
  grep -Eiq "(PID namespaces|SUID sandbox) Yes" /tmp/text
  echo "Rendering controlled fixture"
  google-chrome --headless --user-data-dir=/tmp/profile --dump-dom http://127.0.0.1:4318/ | grep -F "<title>Fieldnote Seed Library</title>" >/dev/null
  echo "Capturing controlled screenshot"
  google-chrome --headless --user-data-dir=/tmp/profile --screenshot=/tmp/field.png http://127.0.0.1:4318/
  file /tmp/field.png | grep -q "PNG image data"
' 2>/dev/null
echo "Chrome sandbox, title and screenshot verified. Checking Kane version."
sudo systemd-run --quiet --wait --pipe "${cli[@]}" "$node_bin" "$root/tools/node_modules/@testmuai/kane-cli/bin/kane-cli.cjs" --version | grep -q '0\.10\.9'
echo 'Hosted fixture, sandboxed Chrome capture, TLS restrictions and resource checks passed.'
if [[ $STAGE == qualify ]]; then exit 0; fi
node -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify([process.env.LT_USERNAME,process.env.LT_ACCESS_KEY]),{mode:0o600})' "$CASE_WORK/login"
sudo systemd-run --quiet --wait --pipe "${cli[@]}" -p "LoadCredential=login:$CASE_WORK/login" "$node_bin" ci/cloud.mjs identity "$STAGE" > "$CASE_WORK/identity"
echo 'Dedicated cloud identity and balance read succeeded.'
if [[ $live == false ]]; then node ci/cloud.mjs account "$STAGE"; exit 0; fi
sudo systemd-run --quiet --unit=field-browser "${web[@]}" /usr/bin/google-chrome --headless --disable-background-networking --user-data-dir=/tmp/field-profile --remote-debugging-port=4319 about:blank
sudo systemd-run --quiet --wait --pipe "${cli[@]}" "$node_bin" --input-type=module -e '
  for(let i=0;i<30;i++){try{const r=await fetch("http://127.0.0.1:4319/json/version");if((await r.json()).Browser.startsWith("Chrome/"))process.exit(0)}catch{}await new Promise(r=>setTimeout(r,300))}process.exit(1)'
node ci/cloud.mjs admission "$STAGE"
# A failed or interrupted launch still goes to private settlement. No retry branch exists.
sudo systemd-run --quiet --wait --pipe "${cli[@]}" "$node_bin" ci/cloud.mjs launch "$STAGE" > "$CASE_WORK/terminal" || true
node ci/cloud.mjs settle "$STAGE"
