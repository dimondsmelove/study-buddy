#!/bin/sh
set -eu

project_dir=/opt/study-buddy
compose_file=$project_dir/compose.yaml
guard=/usr/local/libexec/study-buddy-guard.sh

docker_compose() {
  /usr/bin/docker compose --project-name study-buddy --project-directory "$project_dir" --file "$compose_file" "$@"
}

running_container() {
  [ -n "$(docker_compose ps --quiet --status running backend)" ]
}

stop_backend() {
  docker_compose stop backend
  if running_container; then
    printf '%s\n' 'Backend is still running; keeping the Study Buddy guard installed.' >&2
    return 1
  fi
}

case "${1:-}" in
  start)
    "$guard" apply
    if docker_compose up --detach --no-build --wait --wait-timeout 60 backend; then
      exit 0
    fi
    if docker_compose ps --quiet --status running backend | grep -q .; then
      stop_backend || exit 1
    fi
    "$guard" remove
    exit 1
    ;;
  stop)
    stop_backend
    "$guard" remove
    ;;
  *)
    printf '%s\n' 'Usage: study-buddy-service.sh start|stop' >&2
    exit 1
    ;;
esac
