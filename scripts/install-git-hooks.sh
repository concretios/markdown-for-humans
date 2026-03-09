#!/bin/bash
#
# Install git hooks from .github/hooks/ to .git/hooks/
#
# Usage: ./scripts/install-git-hooks.sh
#

set -e

# ANSI color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

# Get the project root directory
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SOURCE="${PROJECT_ROOT}/.github/hooks"
HOOKS_TARGET="${PROJECT_ROOT}/.git/hooks"

echo ""
echo -e "${CYAN}┌────────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${CYAN}│${RESET}  ${GREEN}Installing Git Hooks${RESET}                                       ${CYAN}│${RESET}"
echo -e "${CYAN}└────────────────────────────────────────────────────────────────┘${RESET}"
echo ""

# Check if .git directory exists
if [ ! -d "${PROJECT_ROOT}/.git" ]; then
  echo -e "${YELLOW}Error: Not a git repository${RESET}"
  echo "Please run this script from within the git repository."
  exit 1
fi

# Check if hooks source directory exists
if [ ! -d "$HOOKS_SOURCE" ]; then
  echo -e "${YELLOW}Error: Hooks source directory not found${RESET}"
  echo "Expected: $HOOKS_SOURCE"
  exit 1
fi

# Install each hook
INSTALLED_COUNT=0

for hook_file in "$HOOKS_SOURCE"/*; do
  # Skip README and non-files
  if [ ! -f "$hook_file" ] || [ "$(basename "$hook_file")" = "README.md" ]; then
    continue
  fi

  hook_name=$(basename "$hook_file")
  target_file="$HOOKS_TARGET/$hook_name"

  # Copy the hook
  cp "$hook_file" "$target_file"

  # Make it executable
  chmod +x "$target_file"

  echo -e "  ${GREEN}✓${RESET} Installed: ${hook_name}"
  ((INSTALLED_COUNT++))
done

echo ""
echo -e "${GREEN}Successfully installed ${INSTALLED_COUNT} git hook(s)${RESET}"
echo ""
echo "Hooks installed in: $HOOKS_TARGET"
echo ""
echo "You can verify installation by running:"
echo "  ls -l .git/hooks/"
echo ""
