const { buildLinkInventory, validateLink, mapWithConcurrency, LINK_VALIDATION_LIMIT } = require("../lib/checklist");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const html = typeof req.body?.html === "string" ? req.body.html : "";

  if (!html.trim()) {
    res.status(400).json({ error: "HTML is required" });
    return;
  }

  try {
    const allCheckable = buildLinkInventory(html).filter((link) => link.checkable);
    const checkableLinks = allCheckable.slice(0, LINK_VALIDATION_LIMIT);
    const skippedCount = allCheckable.length - checkableLinks.length;
    const results = await mapWithConcurrency(checkableLinks, 5, async (link) => ({
      ...link,
      ...(await validateLink(link.href)),
    }));

    res.json({
      checkedCount: results.length,
      skippedCount,
      limit: LINK_VALIDATION_LIMIT,
      results,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
