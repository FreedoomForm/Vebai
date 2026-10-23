// T52d prod E2E: deploy landed + endpoints healthy + auth guards intact
const BASE = "https://vebai-six.vercel.app";
const H = (r) => `${r.status}`;

async function jget(path) {
  const r = await fetch(BASE + path, { redirect: "manual" });
  let body = "";
  try { body = (await r.text()).slice(0, 120); } catch {}
  return { status: r.status, body };
}
async function jpost(path, headers = {}, body = "{}") {
  const r = await fetch(BASE + path, { method: "POST", headers, body, redirect: "manual" });
  let txt = "";
  try { txt = (await r.text()).slice(0, 120); } catch {}
  return { status: r.status, body: txt };
}

const checks = [];
function check(name, cond, detail = "") {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + detail));
  checks.push(cond);
}

// 1. GitHub HEAD is T52d
const gh = await jget ? null : null;
const r = await fetch("https://api.github.com/repos/FreedoomForm/Vebai/commits/main", { headers: { "User-Agent": "vebai-e2e" } });
const ghj = await r.json();
check("github HEAD == 9c9600e (T52d)", String(ghj.sha || "").startsWith("9c9600e"), ghj.sha);

// 2. pages healthy
for (const p of ["/", "/tgagent", "/memory"]) {
  const res = await jget(p);
  check(`GET ${p} -> 200`, res.status === 200, `${res.status} ${res.body}`);
}

// 3. health
const hp = await jget("/api/health");
check("/api/health ok:true", hp.status === 200 && hp.body.includes('"ok":true'), hp.body);

// 4. auth guards intact (no session -> 401)
const cs = await jpost("/api/chat/stream");
check("POST /api/chat/stream no-session -> 401", cs.status === 401, `${cs.status} ${cs.body}`);
const mem = await jget("/api/agent/memory");
check("GET /api/agent/memory no-session -> 401/4xx", [401, 403].includes(mem.status), `${mem.status} ${mem.body}`);

// 5. runner entry guarded (no secret -> 400)
const ghs = await jpost("/api/terminal/gh/send");
check("POST /api/terminal/gh/send no-secret -> 400", ghs.status === 400, `${ghs.status} ${ghs.body}`);

console.log("");
console.log("T52D E2E:", checks.every(Boolean) ? "ALL PASS" : "FAILURES PRESENT");
process.exit(checks.every(Boolean) ? 0 : 1);
