const http = require("http");
const path = require("path");
const fs = require("fs");
const { buildChecklist, buildLinkInventory, validateLink, mapWithConcurrency, LINK_VALIDATION_LIMIT } = require("./lib/checklist");

const PORT = Number(process.env.PORT || 3756);
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_WATCH_DIR = path.join(__dirname, "emails");
const WATCH_DIR = path.resolve(process.env.WATCH_DIR || DEFAULT_WATCH_DIR);
const STARTUP_FILE = path.join(__dirname, "energy-demo-day-reminder-light.html");
const STARTUP_DIR = path.dirname(STARTUP_FILE);
const REQUEST_BODY_LIMIT = 2 * 1024 * 1024;

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
