module.exports = (req, res) => {
  res.status(404).json({ error: "Startup file not available in hosted mode" });
};
