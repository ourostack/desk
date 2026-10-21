"use strict";
// Stable private executable name; maintained execution lives in one worker.
var worker = require("./browser-context-runtime.cjs");
var common = require("./browser-context-common.cjs");
Promise.resolve().then(function() {
  return worker.main(Object.assign({},JSON.parse(process.argv[2]),{mode:"private"}));
}).then(function(result) {
  process.stdout.write(JSON.stringify(result)+"\n");
},function(error) {
  process.stdout.write(JSON.stringify(common.errorPayload(error))+"\n"); process.exitCode = 1;
});
