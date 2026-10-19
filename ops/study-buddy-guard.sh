#!/bin/sh
set -eu

inet_rules_file=/usr/local/share/study-buddy/study-buddy-guard.nft
bridge_rules_file=/usr/local/share/study-buddy/study-buddy-guard-bridge.nft
inet_marker='comment "Study Buddy host-network guard"'
bridge_marker='comment "Study Buddy bridge peer guard"'

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail 'Study Buddy network guard requires root.'
[ -r "$inet_rules_file" ] || fail "Missing rules file: $inet_rules_file"
[ -r "$bridge_rules_file" ] || fail "Missing rules file: $bridge_rules_file"

table_exists() {
  /usr/sbin/nft list table "$1" study_buddy_guard >/dev/null 2>&1
}

assert_guard_bridge_owner() {
  /usr/bin/docker info >/dev/null 2>&1 ||
    fail 'Cannot verify Docker bridge ownership; refusing to change the guard.'
  network=$(/usr/bin/docker network inspect --format '{{.Driver}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Labels "com.docker.compose.project"}}' study-buddy-egress 2>/dev/null) || network=''
  if [ -z "$network" ]; then
    if /usr/sbin/ip link show dev study-buddy0 >/dev/null 2>&1; then
      fail 'study-buddy0 exists without its expected Docker network; refusing to change the guard.'
    fi
    return 0
  fi
  [ "$network" = 'bridge|study-buddy0|study-buddy' ] ||
    fail 'study-buddy-egress is not the expected Study Buddy bridge; refusing to change the guard.'
  /usr/sbin/ip link show dev study-buddy0 >/dev/null 2>&1 ||
    fail 'Expected study-buddy0 bridge interface is missing.'
}

assert_owned_tables() {
  if table_exists inet && ! /usr/sbin/nft list table inet study_buddy_guard | grep -Fq "$inet_marker"; then
    fail 'Refusing to replace an inet table not marked as Study Buddy-owned.'
  fi
  if table_exists bridge && ! /usr/sbin/nft list table bridge study_buddy_guard | grep -Fq "$bridge_marker"; then
    fail 'Refusing to replace a bridge table not marked as Study Buddy-owned.'
  fi
}

assert_guarded_network_stopped() {
  running=$(/usr/bin/docker ps --quiet --filter network=study-buddy-egress) ||
    fail 'Cannot verify the guarded network is stopped; keeping the guard installed.'
  [ -z "$running" ] || fail 'A container is running on study-buddy-egress; refusing to remove its guard.'
}

case "${1:-}" in
  apply)
    assert_guard_bridge_owner
    assert_owned_tables
    temp_file=$(/usr/bin/mktemp)
    trap 'rm -f "$temp_file"' EXIT HUP INT TERM
    {
      if table_exists inet; then
        printf '%s\n' 'delete table inet study_buddy_guard'
      fi
      if table_exists bridge; then
        printf '%s\n' 'delete table bridge study_buddy_guard'
      fi
      cat "$inet_rules_file" "$bridge_rules_file"
    } > "$temp_file"
    /usr/sbin/nft -c -f "$temp_file"
    /usr/sbin/nft -f "$temp_file"
    ;;
  remove)
    assert_guard_bridge_owner
    assert_guarded_network_stopped
    assert_owned_tables
    temp_file=$(/usr/bin/mktemp)
    trap 'rm -f "$temp_file"' EXIT HUP INT TERM
    if table_exists inet; then
      printf '%s\n' 'delete table inet study_buddy_guard' >> "$temp_file"
    fi
    if table_exists bridge; then
      printf '%s\n' 'delete table bridge study_buddy_guard' >> "$temp_file"
    fi
    if [ -s "$temp_file" ]; then
      /usr/sbin/nft -c -f "$temp_file"
      /usr/sbin/nft -f "$temp_file"
    fi
    ;;
  *)
    fail 'Usage: study-buddy-guard.sh apply|remove'
    ;;
esac
