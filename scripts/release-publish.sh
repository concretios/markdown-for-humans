#!/bin/bash
#
# Release credentials and publishing, the only way the release checklist
# publishes. Each store has exactly one credential:
#
#   VS Code Marketplace  Microsoft Entra sign-in from `az login`. No token is
#                        stored; vsce borrows the az identity.
#   Open VSX             Token in the macOS login Keychain, service
#                        ovsx-pat-concretio, account $USER. It is read inline
#                        into OVSX_PAT for one command and never printed.
#
# Usage:
#   scripts/release-publish.sh check                 verify both, upload nothing
#   scripts/release-publish.sh marketplace <vsix>    publish to the Marketplace
#   scripts/release-publish.sh openvsx <vsix>        publish to Open VSX
#
# Publishing is the owner's call: run a publish command only on the owner's
# go for that step (docs/RELEASE_CHECKLIST.md).

set -euo pipefail

TENANT="9620b1de-bb79-421a-9a24-2d5e7a184d10"
MARKETPLACE_RESOURCE="499b84ac-1321-427f-aa17-267ca6975798"
PUBLISHER="concretio"
KEYCHAIN_SERVICE="ovsx-pat-concretio"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

ovsx_token() {
  security find-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null
}

check_marketplace() {
  local tenant expiry
  tenant="$(az account show --query tenantId -o tsv 2>/dev/null || true)"
  [ "$tenant" = "$TENANT" ] ||
    fail "Marketplace: az is not signed in to the concret.io tenant. Run: az login --tenant concret.io --allow-no-subscriptions"
  expiry="$(az account get-access-token --resource "$MARKETPLACE_RESOURCE" --query expiresOn -o tsv 2>/dev/null || true)"
  [ -n "$expiry" ] ||
    fail "Marketplace: az could not get a Marketplace token. Run: az login --tenant concret.io --allow-no-subscriptions"
  # A PAT saved by `vsce login` sits in the Keychain (service vscode-vsce) and a
  # publish without --azure-credential would quietly use it instead of Entra.
  if npx vsce ls-publishers 2>/dev/null | grep -qx "$PUBLISHER"; then
    fail "Marketplace: vsce has a stored PAT for $PUBLISHER. Remove it with: npx vsce logout $PUBLISHER"
  fi
  echo "ok   Marketplace: Entra sign-in, tenant $TENANT, token valid until $expiry"
}

check_openvsx() {
  ovsx_token >/dev/null ||
    fail "Open VSX: no token in the Keychain. Add it (prompts, nothing echoes): security add-generic-password -a \"\$USER\" -s $KEYCHAIN_SERVICE -w"
  OVSX_PAT="$(ovsx_token)" npx ovsx verify-pat "$PUBLISHER" 2>&1 | grep -q "PAT valid to publish at $PUBLISHER" ||
    fail "Open VSX: the Keychain token cannot publish to $PUBLISHER (expired or revoked). Create a new one at https://open-vsx.org/user-settings/tokens and replace it with: security add-generic-password -U -a \"\$USER\" -s $KEYCHAIN_SERVICE -w"
  echo "ok   Open VSX: Keychain token can publish to $PUBLISHER"
}

check_vsix() {
  local vsix="$1" want have
  [ -f "$vsix" ] || fail "no vsix at $vsix"
  want="$(node -p "require('$REPO_ROOT/package.json').version")"
  have="$(unzip -p "$vsix" extension/package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")"
  [ "$have" = "$want" ] || fail "$vsix is version $have, but package.json is $want. Build it again from main."
  echo "vsix $vsix, version $have, sha256 $(shasum -a 256 "$vsix" | cut -d' ' -f1)"
}

case "${1:-}" in
  check)
    check_marketplace
    check_openvsx
    ;;
  marketplace)
    [ $# -eq 2 ] || { echo "Usage: $0 marketplace <vsix>" >&2; exit 2; }
    check_vsix "$2"
    check_marketplace
    npx vsce publish --azure-credential --packagePath "$2"
    ;;
  openvsx)
    [ $# -eq 2 ] || { echo "Usage: $0 openvsx <vsix>" >&2; exit 2; }
    check_vsix "$2"
    check_openvsx
    OVSX_PAT="$(ovsx_token)" npx ovsx publish "$2"
    ;;
  *)
    sed -n '13,15p' "$0" | sed 's/^# */Usage: /;2,$s/^Usage: /       /' >&2
    exit 2
    ;;
esac
