#!/usr/bin/env bash
# 搭一个「本地端到端测试台」：WSL 里一个只听 127.0.0.1:2222 的 sshd + rsync。
#
# 目的：让 rsync 桥能在**真机之外**被完整验证 —— 真 SSH 连接、真 pty 会话、真注入、
# 真过滤器、真收尾，客户端用 Windows 上的 rsync.exe。前面那三个只有真机才暴露的 bug
# （过滤器方向接错、raw 竞态、文件带斜杠）都该被这套拦住。
#
# 用法（Windows 侧，管理员不需要，WSL 允许 -u root）：
#   wsl -u root -d Ubuntu -- bash /mnt/c/.../tools/rsync-e2e/setup-wsl.sh
#
# 它做的事（都可逆）：
#   1. 装 openssh-server + rsync（缺才装）
#   2. 建测试用户 bastiontest（**只允许密钥登录**，没有密码）
#   3. 生成一对测试密钥：私钥复制到 Windows 临时目录给测试用
#   4. 写 /etc/ssh/bastiontest-sshd_config：Port 2222 / ListenAddress 127.0.0.1 / 只允许 bastiontest
#   5. 起 sshd（已在跑就先停掉重启）
#   6. 建远端测试目录 /tmp/bastion-e2e/dst
set -euo pipefail

PORT="${1:-2222}"
TESTUSER=bastiontest
CONF=/etc/ssh/bastiontest-sshd_config
REMOTE_DIR=/tmp/bastion-e2e/dst
# Windows 侧的临时目录：每个人的用户名都不一样，所以从 Windows 自己的环境变量推
# （也可以在外部用 BASTION_E2E_KEY_DIR 直接指定一个 WSL 里的路径覆盖）
if [ -n "${BASTION_E2E_KEY_DIR:-}" ]; then
  WIN_KEY_DIR="$BASTION_E2E_KEY_DIR"
else
  _winlocal="$(cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r' || true)"
  if [ -z "$_winlocal" ]; then
    echo "!! 取不到 Windows 的 %LOCALAPPDATA% —— 请用 BASTION_E2E_KEY_DIR=<WSL 路径> 指定密钥目录"
    exit 1
  fi
  WIN_KEY_DIR="$(wslpath -u "$_winlocal")/Temp/bastion-e2e"
fi
# 密钥按端口区分：这样可以在多个发行版上各搭一套测试台（2222 / 2223……）互不覆盖
KEY="$WIN_KEY_DIR/id_ed25519_$PORT"

echo "=== 1) 装包 ==="
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq openssh-server rsync >/dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q openssh-server rsync >/dev/null
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q openssh-server rsync >/dev/null
else
  echo "!! 不认识的发行版，没法装包"; exit 1
fi
echo "rsync: $(rsync --version | head -1)"
echo "sshd : $(command -v sshd || ls /usr/sbin/sshd)"

echo "=== 2) 测试用户 $TESTUSER（只允许密钥） ==="
if ! id "$TESTUSER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$TESTUSER"
fi
# ⚠️ 别用 `passwd -l`（锁账户）：sshd 会直接拒绝
#    "User ... not allowed because account is locked" —— 连密钥登录都不让。
#    这里删掉密码就行：sshd 配置里已经关掉密码认证，等于只能走密钥。
passwd -d "$TESTUSER" >/dev/null 2>&1 || true

echo "=== 3) 测试密钥 ==="
mkdir -p "$WIN_KEY_DIR"
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N '' -C 'bastion-e2e' -f "$KEY" >/dev/null
fi
install -d -m 700 -o "$TESTUSER" -g "$TESTUSER" "/home/$TESTUSER/.ssh"
install -m 600 -o "$TESTUSER" -g "$TESTUSER" "$KEY.pub" "/home/$TESTUSER/.ssh/authorized_keys"
echo "私钥（Windows 路径）: $(wslpath -w "$KEY")"

echo "=== 4) sshd 配置（只听 127.0.0.1:$PORT） ==="
# sftp-server 的位置各发行版不一样（Debian 在 /usr/lib/openssh，RHEL 系在 /usr/libexec/openssh）
SFTP_SERVER=""
for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server; do
  if [ -x "$p" ]; then SFTP_SERVER="$p"; break; fi
done
echo "sftp-server: ${SFTP_SERVER:-没找到（测试会退回 base64 over exec 校验）}"
cat > "$CONF" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PidFile /run/bastiontest-sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM no
AllowUsers $TESTUSER
StrictModes no
PrintMotd no
# 测试要用 sftp 子系统把远端文件读回来做校验（精简配置里不写这行就没有 sftp）
Subsystem sftp ${SFTP_SERVER:-/usr/lib/openssh/sftp-server}
EOF

echo "=== 5) 起 sshd ==="
ssh-keygen -A >/dev/null
mkdir -p /run/sshd
if [ -f /run/bastiontest-sshd.pid ] && kill -0 "$(cat /run/bastiontest-sshd.pid)" 2>/dev/null; then
  kill "$(cat /run/bastiontest-sshd.pid)" || true
  sleep 0.5
fi
/usr/sbin/sshd -f "$CONF"
sleep 0.5
ss -lntp 2>/dev/null | grep ":$PORT" || echo "(没看到监听，检查 sshd 是否起来)"

echo "=== 6) 远端测试目录 ==="
rm -rf "$REMOTE_DIR"; mkdir -p "$REMOTE_DIR"
chown -R "$TESTUSER:$TESTUSER" /tmp/bastion-e2e

echo
echo "=== 就绪。跑测试时用这些环境变量 ==="
cat <<EOF
BASTION_E2E_SSH=127.0.0.1:$PORT
BASTION_E2E_USER=$TESTUSER
BASTION_E2E_KEY=$(wslpath -w "$KEY")
BASTION_E2E_REMOTE_DIR=$REMOTE_DIR
EOF
