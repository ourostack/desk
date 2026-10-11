"use strict";

module.exports = require("./web-native-artifacts.cjs").artifactFamily("browser-messaging",
  ["go.mod", "main.go", "private_unix.go", "private_windows.go"]);
