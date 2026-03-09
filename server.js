const http = require("http");
const path = require("path");
const fs = require("fs");

const PORT = Number(process.env.PORT || 3756);
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_WATCH_DIR = path.join(__dirname, "emails");
const WATCH_DIR = path.resolve(process.env.WATCH_DIR || DEFAULT_WATCH_DIR);
const STARTUP_FILE = path.join(__dirname, "energy-demo-day-reminder-light.html");
const STARTUP_DIR = path.dirname(STARTUP_FILE);
const REQUEST_BODY_LIMIT = 2 * 1024 * 1024;
const LINK_TIMEOUT_MS = 6000;
const LINK_VALIDATION_LIMIT = 40;

fs.mkdirSync(WATCH_DIR, { recursive: true });

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function isWithinDirectory(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWatchPath(requestedPath) {
  if (!requestedPath) return null;
  const normalized = path.normalize(requestedPath);
  const resolved = path.resolve(WATCH_DIR, normalized);
  return isWithinDirectory(WATCH_DIR, resolved) ? resolved : null;
}

function resolvePublicPath(requestedPath) {
  const normalized = path.normalize(requestedPath);
  const resolved = path.resolve(PUBLIC_DIR, `.${path.sep}${normalized}`);
  return isWithinDirectory(PUBLIC_DIR, resolved) ? resolved : null;
}

function getStartupFilePath() {
  if (!fs.existsSync(STARTUP_FILE)) return null;
  const stat = fs.statSync(STARTUP_FILE);
  return stat.isFile() ? STARTUP_FILE : null;
}

function resolveStartupPath(requestedPath) {
  if (!requestedPath) return null;
  const normalized = path.normalize(requestedPath);
  const resolved = path.resolve(STARTUP_DIR, normalized);
  return isWithinDirectory(STARTUP_DIR, resolved) ? resolved : null;
}

function listHtmlFiles(dir = WATCH_DIR, items = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      listHtmlFiles(absolutePath, items);
      continue;
    }

    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".html") {
      continue;
    }

    const stat = fs.statSync(absolutePath);
    items.push({
      name: toPosixPath(path.relative(WATCH_DIR, absolutePath)),
      mtime: stat.mtimeMs,
      size: stat.size,
    });
  }

  return items.sort((a, b) => b.mtime - a.mtime);
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function readFileUtf8(filePath) {
  return fs.promises.readFile(filePath, "utf8");
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > REQUEST_BODY_LIMIT) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function stripTags(value) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAttributes(tag) {
  const attributes = {};
  const attrPattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;

  while ((match = attrPattern.exec(tag))) {
    const [, rawName, doubleQuoted, singleQuoted, unquoted] = match;
    const name = rawName.toLowerCase();
    if (name === tag.slice(1).split(/\s|>/)[0].toLowerCase()) continue;
    attributes[name] = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
  }

  return attributes;
}

function classifyLink(href) {
  const trimmed = (href || "").trim();

  if (!trimmed) {
    return { type: "empty", checkable: false, issue: "Empty href" };
  }

  if (trimmed === "#") {
    return { type: "placeholder", checkable: false, issue: "Placeholder anchor" };
  }

  if (/^javascript:/i.test(trimmed)) {
    return { type: "unsafe", checkable: false, issue: "javascript: links are not safe for email" };
  }

  if (/^(mailto|tel):/i.test(trimmed)) {
    return { type: trimmed.split(":")[0].toLowerCase(), checkable: false };
  }

  if (/^(https?):/i.test(trimmed)) {
    return {
      type: /^https:/i.test(trimmed) ? "https" : "http",
      checkable: true,
      issue: /^http:/i.test(trimmed) ? "HTTP links should usually be upgraded to HTTPS" : null,
    };
  }

  if (/^(#|\/|\.|\.\.)/.test(trimmed)) {
    return { type: "relative", checkable: false, issue: "Relative links will usually break in email clients" };
  }

  if (/\{\{|\[\[|%%|\*\|/i.test(trimmed)) {
    return { type: "merge-tag", checkable: false, issue: "Dynamic merge tag detected" };
  }

  return { type: "unknown", checkable: false, issue: "Unrecognized link format" };
}

function extractLinks(html) {
  const links = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html))) {
    const href = match[1] ?? match[2] ?? match[3] ?? "";
    const label = stripTags(match[4] || "").slice(0, 120);
    links.push({ href: href.trim(), label });
  }

  return links;
}

function buildLinkInventory(html) {
  const inventory = new Map();

  for (const link of extractLinks(html)) {
    const key = link.href || "";
    const existing = inventory.get(key);

    if (existing) {
      existing.count += 1;
      if (link.label && existing.examples.length < 3 && !existing.examples.includes(link.label)) {
        existing.examples.push(link.label);
      }
      continue;
    }

    const classification = classifyLink(key);
    inventory.set(key, {
      href: key,
      count: 1,
      examples: link.label ? [link.label] : [],
      type: classification.type,
      checkable: classification.checkable,
      issue: classification.issue || null,
    });
  }

  return Array.from(inventory.values()).sort((a, b) => a.href.localeCompare(b.href));
}

function buildChecklist(html, sourceName = "") {
  const findings = [];
  const sizeBytes = Buffer.byteLength(html, "utf8");
  const links = buildLinkInventory(html);
  const images = Array.from(html.matchAll(/<img\b[^>]*>/gi)).map((match) => extractAttributes(match[0]));
  const tables = Array.from(html.matchAll(/<table\b[^>]*>/gi)).map((match) => extractAttributes(match[0]));
  const styleTagCount = (html.match(/<style\b/gi) || []).length;
  const missingAltCount = images.filter((attrs) => !Object.prototype.hasOwnProperty.call(attrs, "alt")).length;
  const emptyAltCount = images.filter((attrs) => Object.prototype.hasOwnProperty.call(attrs, "alt") && attrs.alt.trim() === "").length;
  const relativeLinks = links.filter((link) => link.type === "relative");
  const placeholderLinks = links.filter((link) => link.type === "placeholder" || link.type === "unsafe" || link.type === "empty");
  const httpLinks = links.filter((link) => link.type === "http");
  const unsubscribePresent = /unsubscribe|opt[ -]?out|manage preferences/i.test(html);
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const htmlTagMatch = html.match(/<html\b([^>]*)>/i);
  const langPresent = !!(htmlTagMatch && /\blang\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(htmlTagMatch[1] || ""));
  const viewportPresent = /<meta\b[^>]*name\s*=\s*(?:"viewport"|'viewport'|viewport)[^>]*>/i.test(html);
  const doctypePresent = /<!doctype html>/i.test(html);
  const presentationTables = tables.filter((attrs) => (attrs.role || "").toLowerCase() === "presentation").length;

  const addFinding = (severity, category, message, detail) => {
    findings.push({ severity, category, message, detail: detail || null });
  };

  if (!doctypePresent) {
    addFinding("medium", "Markup", "Missing HTML5 doctype", "Add <!DOCTYPE html> at the top of the document.");
  }

  if (!viewportPresent) {
    addFinding("medium", "Responsiveness", "Missing viewport meta tag", "Mobile email layouts often rely on <meta name=\"viewport\">.");
  }

  if (!titleMatch || !stripTags(titleMatch[1])) {
    addFinding("low", "Metadata", "Missing <title>", "Some inboxes and QA tools surface the document title.");
  }

  if (!langPresent) {
    addFinding("low", "Accessibility", "Missing language on <html>", "Add a lang attribute such as lang=\"en\".");
  }

  if (sizeBytes > 102 * 1024) {
    addFinding("high", "Deliverability", "Email is larger than 102 KB", "Gmail may clip large HTML emails.");
  }

  if (tables.length === 0) {
    addFinding("medium", "Compatibility", "No table-based layout detected", "Many email clients still render table layouts more reliably.");
  }

  if (tables.length > 0 && presentationTables === 0) {
    addFinding("low", "Accessibility", "No layout tables marked as role=\"presentation\"", "Screen readers may announce layout tables unless they are marked correctly.");
  }

  if (images.length > 0 && missingAltCount > 0) {
    addFinding("medium", "Accessibility", `${missingAltCount} image${missingAltCount === 1 ? " is" : "s are"} missing alt text`, "Decorative images can use alt=\"\". Informational images should have descriptive alt text.");
  }

  if (images.length > 0 && emptyAltCount === images.length) {
    addFinding("low", "Accessibility", "All images use empty alt text", "If any image communicates meaning, add descriptive alt text.");
  }

  if (httpLinks.length > 0) {
    addFinding("medium", "Links", `${httpLinks.length} link${httpLinks.length === 1 ? " uses" : "s use"} HTTP`, "Marketing emails should normally use HTTPS links.");
  }

  if (relativeLinks.length > 0) {
    addFinding("high", "Links", `${relativeLinks.length} relative link${relativeLinks.length === 1 ? " was" : "s were"} found`, "Email links should be fully qualified absolute URLs.");
  }

  if (placeholderLinks.length > 0) {
    addFinding("high", "Links", `${placeholderLinks.length} placeholder or unsafe link${placeholderLinks.length === 1 ? " was" : "s were"} found`, "Replace #, empty hrefs, and javascript: links before sending.");
  }

  if (!unsubscribePresent) {
    addFinding("medium", "Compliance", "No unsubscribe or preference-management text detected", "Most marketing sends need an unsubscribe or manage-preferences link.");
  }

  if (styleTagCount > 0) {
    addFinding("info", "CSS", `${styleTagCount} <style> block${styleTagCount === 1 ? "" : "s"} detected`, "Check whether the sending platform will inline or preserve head CSS.");
  }

  return {
    sourceName,
    metrics: {
      sizeBytes,
      sizeKb: Number((sizeBytes / 1024).toFixed(1)),
      linkCount: links.reduce((sum, link) => sum + link.count, 0),
      uniqueLinkCount: links.length,
      imageCount: images.length,
      missingAltCount,
      tableCount: tables.length,
      styleTagCount,
    },
    findings: findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
    links,
  };
}

function severityRank(severity) {
  switch (severity) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
    default:
      return 3;
  }
}

async function validateLink(targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);

  try {
    let response = await fetch(targetUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });

    if ([403, 405, 500, 501].includes(response.status)) {
      response = await fetch(targetUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
    }

    return {
      href: targetUrl,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      redirected: response.redirected,
      note: response.ok ? null : `Server responded with ${response.status}`,
    };
  } catch (error) {
    return {
      href: targetUrl,
      ok: false,
      status: null,
      finalUrl: null,
      redirected: false,
      note: error.name === "AbortError" ? `Timed out after ${LINK_TIMEOUT_MS}ms` : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, worker);
  await Promise.all(workers);
  return results;
}

async function handleApiRequest(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/api/config") {
    const startupFilePath = getStartupFilePath();
    sendJSON(res, 200, {
      port: PORT,
      watchDir: WATCH_DIR,
      defaultWatchDir: DEFAULT_WATCH_DIR,
      startupFileName: startupFilePath ? path.basename(startupFilePath) : null,
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/files") {
    try {
      sendJSON(res, 200, listHtmlFiles());
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/file") {
    const name = parsedUrl.searchParams.get("name");
    const filePath = resolveWatchPath(name || "");

    if (!filePath) {
      sendJSON(res, 400, { error: "Invalid file name" });
      return true;
    }

    if (!fs.existsSync(filePath)) {
      sendJSON(res, 404, { error: "File not found" });
      return true;
    }

    try {
      sendText(res, 200, await readFileUtf8(filePath), "text/html; charset=utf-8");
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/startup-file") {
    const startupFilePath = getStartupFilePath();

    if (!startupFilePath) {
      sendJSON(res, 404, { error: "Startup file not found" });
      return true;
    }

    try {
      sendJSON(res, 200, {
        name: path.basename(startupFilePath),
        html: await readFileUtf8(startupFilePath),
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/analyze") {
    try {
      const body = await readJSONBody(req);
      const html = typeof body.html === "string" ? body.html : "";
      const sourceName = typeof body.sourceName === "string" ? body.sourceName : "Untitled email";

      if (!html.trim()) {
        sendJSON(res, 400, { error: "HTML is required" });
        return true;
      }

      sendJSON(res, 200, buildChecklist(html, sourceName));
    } catch (error) {
      sendJSON(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/validate-links") {
    try {
      const body = await readJSONBody(req);
      const html = typeof body.html === "string" ? body.html : "";

      if (!html.trim()) {
        sendJSON(res, 400, { error: "HTML is required" });
        return true;
      }

      const allCheckable = buildLinkInventory(html).filter((link) => link.checkable);
      const checkableLinks = allCheckable.slice(0, LINK_VALIDATION_LIMIT);
      const skippedCount = allCheckable.length - checkableLinks.length;
      const results = await mapWithConcurrency(checkableLinks, 5, async (link) => ({
        ...link,
        ...(await validateLink(link.href)),
      }));

      sendJSON(res, 200, {
        checkedCount: results.length,
        skippedCount,
        limit: LINK_VALIDATION_LIMIT,
        results,
      });
    } catch (error) {
      sendJSON(res, 400, { error: error.message });
    }
    return true;
  }

  return false;
}

function isServableFile(filePath) {
  return filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function sendNotFound(res) {
  res.writeHead(404);
  res.end("Not Found");
}

function serveIfExists(res, filePath) {
  if (!isServableFile(filePath)) {
    sendNotFound(res);
    return;
  }
  serveFile(res, filePath);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  if (await handleApiRequest(req, res, parsedUrl)) {
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/preview/")) {
    serveIfExists(res, resolveWatchPath(pathname.replace(/^\/preview\//, "")));
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/preview-startup/")) {
    const startupFilePath = getStartupFilePath();
    const filePath = resolveStartupPath(pathname.replace(/^\/preview-startup\//, ""));

    if (!startupFilePath) {
      sendNotFound(res);
      return;
    }

    serveIfExists(res, filePath);
    return;
  }

  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  serveIfExists(res, resolvePublicPath(requestedPath));
});

server.listen(PORT, () => {
  console.log(`HTML Email Viewer running at http://localhost:${PORT}`);
});
