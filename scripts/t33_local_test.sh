#!/usr/bin/env bash
# T33 local sanity for .github/tg.js — honest error paths without real MTProto.
set -u
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
check() { if [ "$1" = "0" ]; then PASS=$((PASS+1)); echo "  ok: $2"; else FAIL=$((FAIL+1)); echo "  FAIL: $2"; fi }
# negative-case helper: pass when exit code is NON-zero
checkne() { if [ "$1" != "0" ]; then PASS=$((PASS+1)); echo "  ok: $2"; else FAIL=$((FAIL+1)); echo "  FAIL: $2"; fi }

echo "== 1) no SECRET -> honest error, exit 1"
OUT=$(env -u SECRET SITE=http://127.0.0.1:9 node .github/tg.js whoami 2>/dev/null); RC=$?
echo "$OUT" | head -c 200; echo
checkne $RC "exit!=0"
echo "$OUT" | grep -q '"ok":false' ; check $? "ok:false in JSON"
echo "$OUT" | grep -q 'SECRET' ; check $? "mentions SECRET"

echo "== 2) mock site: no connected account -> honest error, exit 1"
cat > /tmp/t33_mock.js <<'EOF'
require('http').createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    const p = JSON.parse(b || '{}')
    res.setHeader('content-type', 'application/json')
    if (p.secret !== 'good') { res.statusCode = 403; res.end(JSON.stringify({ error: 'forbidden' })); return }
    res.end(JSON.stringify({ ok: false, error: 'нет подключённого Telegram-аккаунта — владелец должен подключить его на /tgagent' }))
  })
}).listen(41233)
EOF
node /tmp/t33_mock.js & MPID=$!
sleep 0.5
OUT=$(SECRET=good SITE=http://127.0.0.1:41233 node .github/tg.js dialogs 5 2>/dev/null); RC=$?
kill $MPID 2>/dev/null
echo "$OUT"; 
checkne $RC "exit!=0 on ok:false account"
echo "$OUT" | grep -q 'подключённого' ; check $? "honest no-account message"

echo "== 3) mock site: 403 -> honest forbidden, exit 1"
node /tmp/t33_mock.js & MPID=$!
sleep 0.5
OUT=$(SECRET=bad SITE=http://127.0.0.1:41233 node .github/tg.js whoami 2>/dev/null); RC=$?
kill $MPID 2>/dev/null
echo "$OUT"
checkne $RC "exit!=0 on 403"
echo "$OUT" | grep -q 'forbidden' ; check $? "forbidden surfaced"

echo "== 4) --timeout flag consumed (does not break command name)"
OUT=$(env -u SECRET SITE=http://127.0.0.1:9 node .github/tg.js --timeout 5 dialogs 2>/dev/null); RC=$?
echo "$OUT" | head -c 120; echo
checkne $RC "exit!=0"
echo "$OUT" | grep -q 'SECRET' ; check $? "SECRET error (not 'unknown command')"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
