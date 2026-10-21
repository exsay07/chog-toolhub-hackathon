#!/usr/bin/env bash
# Chog Toolhub — first-time setup of a fresh Ubuntu 22.04 / 24.04 VPS (Contabo, Hetzner, …).
# Run ONCE as root, right after the first login. The repository is private, so copy the file from
# your PC first (PowerShell, in the project folder):
#
#   scp deploy/setup-vps.sh root@<server IP>:
#   ssh root@<server IP>        then:   bash setup-vps.sh
#
# What it does (safe to re-run):
#   • system updates + automatic security updates
#   • user "chog" (sudo + docker); root can no longer log in over SSH
#   • firewall: everything closed except SSH (the site is reached through the Cloudflare Tunnel,
#     so no web port is ever opened); fail2ban against password guessing
#   • 2 GB swap, Docker Engine + compose plugin with log rotation
#   • a read-only GitHub deploy key for the private repository
set -euo pipefail

APP_USER=chog
REPO=git@github.com:exsay07/chog-toolhub-hackathon.git

say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (you are $(whoami))"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "made for Ubuntu (found ${PRETTY_NAME:-unknown})"
export DEBIAN_FRONTEND=noninteractive

say "1/7 System update"
apt-get update -q
apt-get -yq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
apt-get -yq install ca-certificates curl git ufw fail2ban unattended-upgrades openssl

say "2/7 Automatic security updates"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

say "3/7 User '$APP_USER'"
# Without a terminal (run over SSH by a script) there is nobody to type a password: then the user logs
# in with the SSH key only and gets password-less sudo (key-only SSH is enforced below).
NONINTERACTIVE=no
[ -t 0 ] || NONINTERACTIVE=yes
if ! id "$APP_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$APP_USER"
  if [ "$NONINTERACTIVE" = no ]; then
    echo "Choose a password for '$APP_USER' (you will log in with it from now on):"
    until passwd "$APP_USER"; do echo "Try again."; done
  fi
fi
usermod -aG sudo "$APP_USER"
# Keys root already accepts (if you set one up in the Contabo panel) work for the new user too.
if [ -s /root/.ssh/authorized_keys ]; then
  install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/.ssh"
  touch "/home/$APP_USER/.ssh/authorized_keys"
  sort -u /root/.ssh/authorized_keys "/home/$APP_USER/.ssh/authorized_keys" -o "/home/$APP_USER/.ssh/authorized_keys"
  chown "$APP_USER:$APP_USER" "/home/$APP_USER/.ssh/authorized_keys"
  chmod 600 "/home/$APP_USER/.ssh/authorized_keys"
fi

say "4/7 SSH hardening + firewall + fail2ban"
HAS_KEY=no
[ -s "/home/$APP_USER/.ssh/authorized_keys" ] && HAS_KEY=yes
if [ "$NONINTERACTIVE" = yes ]; then
  [ "$HAS_KEY" = yes ] || die "no SSH key for root/$APP_USER — refusing a non-interactive run (you would be locked out)"
  echo "$APP_USER ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/90-chog
  chmod 440 /etc/sudoers.d/90-chog
  visudo -cf /etc/sudoers.d/90-chog >/dev/null || { rm -f /etc/sudoers.d/90-chog; die "sudoers check failed"; }
fi
{
  echo "# Chog Toolhub hardening (deploy/setup-vps.sh)"
  echo "PermitRootLogin no"
  echo "MaxAuthTries 4"
  echo "X11Forwarding no"
  # Passwords stay allowed until you have an SSH key, so you can never lock yourself out.
  if [ "$HAS_KEY" = yes ]; then echo "PasswordAuthentication no"; fi
} >/etc/ssh/sshd_config.d/01-chog.conf
# sshd keeps the FIRST value it reads: 01- beats the provider's 50-cloud-init.conf (PasswordAuthentication yes).
rm -f /etc/ssh/sshd_config.d/99-chog.conf
sshd -t || { rm -f /etc/ssh/sshd_config.d/01-chog.conf; die "sshd config check failed (left unchanged)"; }
systemctl reload ssh 2>/dev/null || systemctl reload sshd
sshd -T | grep -iE '^(permitrootlogin|passwordauthentication) '

ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
ufw status verbose | head -n 12

# Never ban the address this setup is run from (an admin's script retrying would lock them out for an hour).
ADMIN_IP=${SSH_CLIENT%% *}
cat >/etc/fail2ban/jail.d/chog.local <<EOF
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 ${ADMIN_IP:-}

[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

say "5/7 Swap"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
sysctl -q -w vm.swappiness=10
echo 'vm.swappiness=10' >/etc/sysctl.d/99-chog.conf
swapon --show

say "6/7 Docker"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
install -d /etc/docker
cat >/etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
systemctl enable docker >/dev/null
systemctl restart docker
usermod -aG docker "$APP_USER"
docker --version
docker compose version

say "7/7 GitHub deploy key (read-only access to the private repository)"
KEY="/home/$APP_USER/.ssh/github_deploy"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/.ssh"
if [ ! -f "$KEY" ]; then
  sudo -u "$APP_USER" ssh-keygen -q -t ed25519 -N "" -C "chog-toolhub-vps" -f "$KEY"
fi
cat >"/home/$APP_USER/.ssh/config" <<EOF
Host github.com
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
chown "$APP_USER:$APP_USER" "/home/$APP_USER/.ssh/config"
chmod 600 "/home/$APP_USER/.ssh/config"
sudo -u "$APP_USER" sh -c 'ssh-keyscan -t ed25519 github.com >>~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts'

cat <<EOF

────────────────────────────────────────────────────────────────────────────
 Server ready.  Next:

 1) GitHub → exsay07/chog-toolhub-hackathon → Settings → Deploy keys → Add deploy key
    Title: contabo   ·   leave "Allow write access" OFF   ·   Key:

$(cat "$KEY.pub")

 2) Log out, then log in again as:   ssh $APP_USER@<server IP>
    (root login over SSH is now disabled$( [ "$HAS_KEY" = no ] && echo '; use the password you just chose' ))

 3) As $APP_USER:
      git clone $REPO
      cd chog-toolhub && bash deploy/install.sh
────────────────────────────────────────────────────────────────────────────
EOF
