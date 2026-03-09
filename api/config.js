module.exports = (req, res) => {
  res.json({
    port: null,
    watchDir: null,
    defaultWatchDir: null,
    startupFileName: null,
  });
};
