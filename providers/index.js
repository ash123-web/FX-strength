const mockProvider = require("./mockProvider");
const twelveDataProvider = require("./twelveDataProvider");

function getProvider() {
  const choice = (process.env.DATA_PROVIDER || "mock").toLowerCase();
  if (choice === "twelvedata") return twelveDataProvider;
  if (choice === "mock") return mockProvider;
  throw new Error(
    `Unknown DATA_PROVIDER "${choice}". Use "mock" or "twelvedata", or add a ` +
    `new provider file implementing the same interface (see providerInterface.js) ` +
    `and register it here.`
  );
}

module.exports = { getProvider };
