const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3756;
const WATCH_DIR = path.resolve(
  process.env.WATCH_DIR || "C:\\Users\\EthanRejto\\Documents\\path_vibe_website\\email-campaigns"
);

// Ensure watched directory exists
fs.mkdirSync(WATCH_DIR, { recursive: true });

// --- Helpers ---

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

function getFileList() {
  try {
    return fs
      .readdirSync(WATCH_DIR)
      .filter((f) => f.endsWith(".html"))
      .map((f) => {
        const stat = fs.statSync(path.join(WATCH_DIR, f));
        return { name: f, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;

  // API: list files
  if (req.method === "GET" && pathname === "/api/files") {
    try {
      sendJSON(res, 200, getFileList());
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // API: serve a specific HTML file
  if (req.method === "GET" && pathname === "/api/file") {
    const name = parsed.searchParams.get("name");
    if (!name) return sendJSON(res, 400, { error: "Missing name parameter" });

    const safeName = path.basename(name);
    const filePath = path.join(WATCH_DIR, safeName);

    if (!fs.existsSync(filePath)) {
      return sendJSON(res, 404, { error: "File not found" });
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Static files from public/
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(__dirname, "public", path.normalize(filePath));

  // Prevent directory traversal outside public/
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(data);
  });
});

// --- WebSocket ---

const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// --- Watch directory with fs.watch + debounce ---

let debounceTimer = null;
let pendingFile = null;

fs.watch(WATCH_DIR, (eventType, filename) => {
  if (!filename || !filename.endsWith(".html")) return;

  pendingFile = filename;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const filePath = path.join(WATCH_DIR, pendingFile);
    const event = fs.existsSync(filePath) ? "change" : "unlink";
    console.log(`[${event}] ${pendingFile}`);
    broadcast({ type: "change", event, file: pendingFile, files: getFileList() });
    pendingFile = null;
  }, 300);
});

// --- Start ---

server.listen(PORT, () => {
  console.log(`HTML Email Viewer running at http://localhost:${PORT}`);
  console.log(`Watching: ${WATCH_DIR}`);
});
