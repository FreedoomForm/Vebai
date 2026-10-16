/**
 * Guest-side shell scripts that run INSIDE the browser VM (busybox sh).
 * The page bootstraps them after login via:
 *   wget -qO- "<origin>/api/terminal/guest/init.sh" | sh -s <origin> <sid> <secret>
 *
 * init.sh    - installs+starts the workspace sync daemon (POST changed files)
 * restore.sh - pulls the session's file manifest and re-downloads every file
 */

export function guestInitSh(): string {
	return `#!/bin/sh
# Vebai terminal: workspace -> server sync daemon (busybox sh)
ORIGIN="$1"; SID="$2"; SECRET="$3"
[ -z "$ORIGIN" ] && exit 1
mkdir -p /root/workspace
MARK=/root/.vsync-mark
[ -f "$MARK" ] || touch "$MARK"

cat > /root/.vsync.sh <<VSH
#!/bin/sh
cd /root/workspace || exit 0
LIST=\$(find . -type f -newer "\$MARK" ! -path "./.cache/*" 2>/dev/null | head -40)
[ -z "\$LIST" ] && exit 0
tar czf /tmp/.vsync.tgz \$LIST 2>/dev/null || exit 0
wget -qO /tmp/.vsync-res \\
  --header="X-Term-Secret: \$SECRET" \\
  --post-file=/tmp/.vsync.tgz \\
  "\$ORIGIN/api/terminal/sessions/\$SID/upload" \\
  && touch "\$MARK" && echo "[vebai] synced: \$(echo \$LIST | tr '\\n' ' ')" >> /root/.vsync.log
rm -f /tmp/.vsync.tgz
VSH
chmod +x /root/.vsync.sh

# stop previous daemon instance if any
pkill -f "vsync.sh" 2>/dev/null
( while true; do sh /root/.vsync.sh >/dev/null 2>&1; sleep 25; done ) &
echo "[vebai] file sync daemon started"
`
}

export function guestRestoreSh(): string {
	return `#!/bin/sh
# Vebai terminal: restore workspace files from the server manifest
ORIGIN="$1"; SID="$2"; SECRET="$3"
mkdir -p /root/workspace
cd /root/workspace || exit 1
wget -qO /tmp/.vrest.tsv \\
  --header="X-Term-Secret: $SECRET" \\
  "$ORIGIN/api/terminal/sessions/$SID/files?format=tsv" || exit 1
N=0
while IFS='	' read -r ID PATH_; do
  [ -z "$ID" ] && continue
  mkdir -p "$(dirname "$PATH_")"
  wget -qO "$PATH_" --header="X-Term-Secret: $SECRET" \\
    "$ORIGIN/api/terminal/files/$ID" && N=$((N+1))
done < /tmp/.vrest.tsv
touch /root/.vsync-mark
echo "[vebai] restored $N file(s) into /root/workspace"
`
}
