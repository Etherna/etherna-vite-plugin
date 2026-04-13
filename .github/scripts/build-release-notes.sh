#!/usr/bin/env bash
# Builds release-body.md from git commits between the previous v* tag and the given tag.
# GitHub's API only lists merged PRs; this supplements (or replaces) empty generated notes.
set -euo pipefail

CURRENT="${1:-}"
OUT="${2:-release-body.md}"

if [[ -z "$CURRENT" ]]; then
  echo "usage: $0 <tag> [output.md]" >&2
  exit 1
fi

git fetch --tags --force

PREV=""
while read -r t; do
  if [[ "$t" == "$CURRENT" ]]; then
    break
  fi
  PREV="$t"
done < <(git tag -l 'v*' --sort=v:refname)

if [[ -n "$PREV" ]]; then
  RANGE="${PREV}..${CURRENT}"
else
  RANGE="$CURRENT"
fi

COMMITS=()
while IFS= read -r line; do
  COMMITS+=("$line")
done < <(git log --format='%h %s' "$RANGE" --reverse 2>/dev/null || true)

{
  echo "## Changes"
  echo ""

  if [[ ${#COMMITS[@]} -eq 0 ]]; then
    echo "_No commits found in range \`${RANGE}\`._"
    echo ""
  else
    declare -a BREAKING=() FEAT=() FIX=() MAINT=() OTHER=()

    # Regexes in variables so `)` does not close `[[` (bash parsing quirk).
    re_breaking='^[a-z]+(\([^)]+\))?!:'
    re_feat='^feat(\([^)]+\))?:'
    re_fix='^fix(\([^)]+\))?:'
    re_maint='^(chore|docs|style|refactor|perf|test|ci|build|revert)(\([^)]+\))?:'

    for line in "${COMMITS[@]}"; do
      hash="${line%% *}"
      rest="${line#* }"

      if [[ "$rest" =~ $re_breaking ]] || [[ "$rest" =~ ^BREAKING ]]; then
        BREAKING+=("- ${rest} (\`${hash}\`)")
      elif [[ "$rest" =~ $re_feat ]]; then
        FEAT+=("- ${rest} (\`${hash}\`)")
      elif [[ "$rest" =~ $re_fix ]]; then
        FIX+=("- ${rest} (\`${hash}\`)")
      elif [[ "$rest" =~ $re_maint ]]; then
        MAINT+=("- ${rest} (\`${hash}\`)")
      else
        OTHER+=("- ${rest} (\`${hash}\`)")
      fi
    done

    if [[ ${#BREAKING[@]} -gt 0 ]]; then
      echo "### Breaking changes"
      printf '%s\n' "${BREAKING[@]}"
      echo ""
    fi
    if [[ ${#FEAT[@]} -gt 0 ]]; then
      echo "### Features"
      printf '%s\n' "${FEAT[@]}"
      echo ""
    fi
    if [[ ${#FIX[@]} -gt 0 ]]; then
      echo "### Fixes"
      printf '%s\n' "${FIX[@]}"
      echo ""
    fi
    if [[ ${#MAINT[@]} -gt 0 ]]; then
      echo "### Maintenance"
      printf '%s\n' "${MAINT[@]}"
      echo ""
    fi
    if [[ ${#OTHER[@]} -gt 0 ]]; then
      echo "### Other commits"
      printf '%s\n' "${OTHER[@]}"
      echo ""
    fi
  fi
  echo ""
} >"$OUT"
