#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/ratacat/pro-cli.git"

log() {
  printf 'pro-cli install: %s\n' "$1"
}

die() {
  printf 'pro-cli install: %s\n' "$1" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "missing required command: $1"
  fi
}

verify_origin() {
  local origin_url

  if ! origin_url="$(git -C "$INSTALL_DIR" remote get-url origin)"; then
    die "$INSTALL_DIR has no origin remote"
  fi

  case "$origin_url" in
    "$REPO_URL" | "https://github.com/ratacat/pro-cli" | "git@github.com:ratacat/pro-cli.git")
      ;;
    *)
      die "$INSTALL_DIR origin is $origin_url, expected $REPO_URL"
      ;;
  esac
}

update_existing_checkout() {
  local branch

  verify_origin

  branch="$(git -C "$INSTALL_DIR" branch --show-current)"
  if [ -z "$branch" ]; then
    die "$INSTALL_DIR is not on a branch; check out main before reinstalling"
  fi

  if [ "$branch" != "main" ]; then
    die "$INSTALL_DIR is on branch $branch; switch to main before reinstalling"
  fi

  if [ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]; then
    die "$INSTALL_DIR has uncommitted changes; commit or stash them before reinstalling"
  fi

  log "updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only origin main
}

clone_checkout() {
  if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
    die "$INSTALL_DIR exists but is not a directory"
  fi

  if [ -d "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    die "$INSTALL_DIR exists but is not a pro-cli git checkout"
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  log "cloning $REPO_URL into $INSTALL_DIR"
  git clone --branch main "$REPO_URL" "$INSTALL_DIR"
}

if [ -n "${PRO_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="$PRO_INSTALL_DIR"
else
  if [ -z "${HOME:-}" ]; then
    die "HOME is not set; set PRO_INSTALL_DIR"
  fi
  INSTALL_DIR="${HOME}/Projects/pro-cli"
fi

if [ -z "$INSTALL_DIR" ]; then
  die "PRO_INSTALL_DIR resolved to an empty path"
fi

require_command git
require_command bun

if [ -d "$INSTALL_DIR/.git" ]; then
  update_existing_checkout
else
  clone_checkout
fi

cd "$INSTALL_DIR"

log "installing dependencies"
bun install

log "linking pro"
bun link

if ! command -v pro >/dev/null 2>&1; then
  die "bun link completed, but pro is not on PATH"
fi

log "installed $(pro --version)"
