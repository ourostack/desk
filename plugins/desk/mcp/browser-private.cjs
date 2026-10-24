"use strict";
function run(argv, options) { return require("./browser-local.cjs").run(argv,options,"private"); }
module.exports = {run:run};
if (require.main === module) run(process.argv.slice(2)).then(function(result) {
  process.stdout.write(JSON.stringify(result.payload)+"\n"); process.exitCode = result.exitCode;
});
