const fs = require("fs");
const path = require("path");

module.exports = (req, res) => {
  const filePath = path.join(__dirname, "..", "energy-demo-day-reminder-light.html");

  try {
    const html = fs.readFileSync(filePath, "utf8");
    res.json({ name: "energy-demo-day-reminder-light.html", html });
  } catch {
    res.status(404).json({ error: "Startup file not found" });
  }
};
