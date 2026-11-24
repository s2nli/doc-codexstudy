// Live reverse proxy of the HRRY DISHA frontend served at the site root: /  and  /assets/*  -> https://hrrydocpro.ai.studio/*
// Nothing is copied: HTML/JS/CSS are fetched live and only the URLs are re-pointed to this site.
const ORIGIN = "https://hrrydocpro.ai.studio";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36";

function pathOf(req) {
  let p = req.query && req.query.path;
  p = Array.isArray(p) ? p.join("/") : (p || "");
  if (!p) p = new URL(req.url, "http://x").pathname.replace(/^\/(api\/site)?\/?/, "");
  return p.replace(/^\/+/, "");
}

function rewriteHtml(t) { return t; }   // root-relative URLs already work at the site root
function rewriteJs(t) {
  return t.split(ORIGIN + "/api").join("/api/hrry");
}
function rewriteCss(t) { return t; }

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
  let p = pathOf(req);
  const isFile = /\.[a-z0-9]{1,6}$/i.test(p);
  if (!isFile) p = "";                                   // SPA route -> index.html
  try {
    const r = await fetch(`${ORIGIN}/${p}`, { headers: { "User-Agent": UA, Accept: "*/*" } });
    const type = r.headers.get("content-type") || "application/octet-stream";
    res.status(r.status);
    res.setHeader("Content-Type", type);
    const isHtml = /text\/html/i.test(type), isJs = /javascript/i.test(type), isCss = /text\/css/i.test(type);
    res.setHeader("Cache-Control", isHtml ? "public, s-maxage=60, stale-while-revalidate=300" : "public, s-maxage=3600, stale-while-revalidate=86400");
    if (isHtml || isJs || isCss) {
      let t = await r.text();
      t = isHtml ? rewriteHtml(t) : isJs ? rewriteJs(t) : rewriteCss(t);
      return res.end(t);
    }
    return res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).setHeader("Content-Type", "text/plain");
    res.end("HRRY upstream unreachable: " + (e && e.message || e));
  }
};
module.exports._t = { rewriteHtml, rewriteJs, rewriteCss, pathOf };
