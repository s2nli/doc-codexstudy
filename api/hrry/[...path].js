// HRRY DISHA proxy (serverless version of app.py). Route: /api/hrry/<path> -> BASE_API/<path>
const { Readable } = require("stream");

const BASE_API = "https://hrrydocpro.ai.studio/api";
const SESSION_TTL = 10 * 60 * 1000;
let cache = { token: null, at: 0 };

async function getSession(force) {
  if (!force && cache.token && Date.now() - cache.at < SESSION_TTL) return cache.token;
  try {
    const ch = await (await fetch(`${BASE_API}/gate/challenge`)).json();
    const answer = String(ch.question).split("+").reduce((a, x) => a + parseInt(x.trim(), 10), 0);
    const v = await (await fetch(`${BASE_API}/gate/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken: ch.challengeToken, answer, slideRatio: 0.95, dwellMs: 1500 })
    })).json();
    if (v && v.sessionToken) { cache = { token: v.sessionToken, at: Date.now() }; return cache.token; }
  } catch (e) {}
  return null;
}

const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"];

async function upstream(req, url, token) {
  const headers = { Accept: "application/json" };
  if (token) headers["X-Gate-Session"] = token;
  if (req.headers.range) headers.Range = req.headers.range;
  const init = { method: req.method, headers };
  if (req.method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(req.body || {});
  }
  return fetch(url, init);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Headers", "*");
    return res.status(204).end();
  }
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const u = new URL(req.url, "http://localhost");
  let path = req.query && req.query.path;
  path = Array.isArray(path) ? path.join("/") : (path || "");
  if (!path) path = u.pathname.replace(/^\/api\/(hrry\/)?/, "");   // /api/hrry/x, or rewritten /api/stream, /api/doc
  path = path.replace(/^\/+/, "");
  u.searchParams.delete("path");
  const search = u.searchParams.toString();
  const url = `${BASE_API}/${path}${search ? "?" + search : ""}`;
  const isGate = path.startsWith("gate/");

  try {
    let token = isGate ? null : await getSession(false);
    if (!isGate && !token) return res.status(500).json({ error: "Session failed" });
    let r = await upstream(req, url, token);
    if (!isGate && (r.status === 401 || r.status === 403)) {   // expired session -> refresh once
      token = await getSession(true);
      if (token) r = await upstream(req, url, token);
    }
    res.status(r.status);
    PASS.forEach((h) => { const val = r.headers.get(h); if (val) res.setHeader(h, val); });
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).on("error", () => res.end()).pipe(res);
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
};
