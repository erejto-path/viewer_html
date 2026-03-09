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

  if (!trimmed) return { type: "empty", checkable: false, issue: "Empty href" };
  if (trimmed === "#") return { type: "placeholder", checkable: false, issue: "Placeholder anchor" };
  if (/^javascript:/i.test(trimmed)) return { type: "unsafe", checkable: false, issue: "javascript: links are not safe for email" };
  if (/^(mailto|tel):/i.test(trimmed)) return { type: trimmed.split(":")[0].toLowerCase(), checkable: false };

  if (/^(https?):/i.test(trimmed)) {
    return {
      type: /^https:/i.test(trimmed) ? "https" : "http",
      checkable: true,
      issue: /^http:/i.test(trimmed) ? "HTTP links should usually be upgraded to HTTPS" : null,
    };
  }

  if (/^(#|\/|\.|\.\.)/.test(trimmed)) return { type: "relative", checkable: false, issue: "Relative links will usually break in email clients" };
  if (/\{\{|\[\[|%%|\*\|/i.test(trimmed)) return { type: "merge-tag", checkable: false, issue: "Dynamic merge tag detected" };

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

function severityRank(severity) {
  switch (severity) {
    case "high": return 0;
    case "medium": return 1;
    case "low": return 2;
    default: return 3;
  }
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

  const add = (severity, category, message, detail) => {
    findings.push({ severity, category, message, detail: detail || null });
  };

  if (!doctypePresent) add("medium", "Markup", "Missing HTML5 doctype", "Add <!DOCTYPE html> at the top of the document.");
  if (!viewportPresent) add("medium", "Responsiveness", "Missing viewport meta tag", "Mobile email layouts often rely on <meta name=\"viewport\">.");
  if (!titleMatch || !stripTags(titleMatch[1])) add("low", "Metadata", "Missing <title>", "Some inboxes and QA tools surface the document title.");
  if (!langPresent) add("low", "Accessibility", "Missing language on <html>", "Add a lang attribute such as lang=\"en\".");
  if (sizeBytes > 102 * 1024) add("high", "Deliverability", "Email is larger than 102 KB", "Gmail may clip large HTML emails.");
  if (tables.length === 0) add("medium", "Compatibility", "No table-based layout detected", "Many email clients still render table layouts more reliably.");
  if (tables.length > 0 && presentationTables === 0) add("low", "Accessibility", "No layout tables marked as role=\"presentation\"", "Screen readers may announce layout tables unless they are marked correctly.");
  if (images.length > 0 && missingAltCount > 0) add("medium", "Accessibility", `${missingAltCount} image${missingAltCount === 1 ? " is" : "s are"} missing alt text`, "Decorative images can use alt=\"\". Informational images should have descriptive alt text.");
  if (images.length > 0 && emptyAltCount === images.length) add("low", "Accessibility", "All images use empty alt text", "If any image communicates meaning, add descriptive alt text.");
  if (httpLinks.length > 0) add("medium", "Links", `${httpLinks.length} link${httpLinks.length === 1 ? " uses" : "s use"} HTTP`, "Marketing emails should normally use HTTPS links.");
  if (relativeLinks.length > 0) add("high", "Links", `${relativeLinks.length} relative link${relativeLinks.length === 1 ? " was" : "s were"} found`, "Email links should be fully qualified absolute URLs.");
  if (placeholderLinks.length > 0) add("high", "Links", `${placeholderLinks.length} placeholder or unsafe link${placeholderLinks.length === 1 ? " was" : "s were"} found`, "Replace #, empty hrefs, and javascript: links before sending.");
  if (!unsubscribePresent) add("medium", "Compliance", "No unsubscribe or preference-management text detected", "Most marketing sends need an unsubscribe or manage-preferences link.");
  if (styleTagCount > 0) add("info", "CSS", `${styleTagCount} <style> block${styleTagCount === 1 ? "" : "s"} detected`, "Check whether the sending platform will inline or preserve head CSS.");

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

const LINK_TIMEOUT_MS = 6000;
const LINK_VALIDATION_LIMIT = 40;

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

module.exports = {
  buildChecklist,
  buildLinkInventory,
  validateLink,
  mapWithConcurrency,
  LINK_VALIDATION_LIMIT,
};
