"use strict";

var builder = require("./build-browser-launch-assets.cjs");

function run(args, options) {
  builder.run(args, Object.assign({}, options || {}, { family: "browser-messaging" }));
}

module.exports = { run: run };
/* istanbul ignore next */
if (require.main === module) run(process.argv.slice(2));
