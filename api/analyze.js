const { buildChecklist } = require("../lib/checklist");

module.exports = (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const html = typeof req.body?.html === "string" ? req.body.html : "";
  const sourceName = typeof req.body?.sourceName === "string" ? req.body.sourceName : "Untitled email";

  if (!html.trim()) {
    res.status(400).json({ error: "HTML is required" });
    return;
  }

  res.json(buildChecklist(html, sourceName));
};
