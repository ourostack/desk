// Pure normal browser discovery extracted from mcp/web.cjs at
// f1502a4b6e451a1611957f8a5064d87eb547a611. No CLI/runtime acquisition.
"use strict";

var path = require("path");

// Where Playwright itself looks for the chrome and msedge channels.
function browserPaths(browser, platform, env) {
  if (platform === "win32") {
    var roots = ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"].map(function (name) {
      var key = Object.keys(env).filter(function (candidate) {
        return candidate.toUpperCase() === name;
      })[0];
      return env[key];
    }).filter(Boolean);
    var tail = browser === "chrome" ? ["Google", "Chrome", "Application", "chrome.exe"] : ["Microsoft", "Edge", "Application", "msedge.exe"];
    return roots.map(function (root) {
      return path.win32.join.apply(path.win32, [root].concat(tail));
    });
  }
  if (platform === "darwin") return ["/Applications/" + macBundle(browser)];
  return browser === "chrome" ? ["/opt/google/chrome/chrome"] : ["/opt/microsoft/msedge/msedge"];
}

function macBundle(browser) {
  var app = browser === "chrome" ? "Google Chrome" : "Microsoft Edge";
  return app + ".app/Contents/MacOS/" + app;
}

function userBrowserPaths(browser, platform, env, options) {
  // Native consumers pass a trusted pre-isolation/OS account home explicitly.
  // Omission preserves the ordinary launcher's historical env.HOME behavior.
  var home = options && Object.prototype.hasOwnProperty.call(options, "nativeHome") ? options.nativeHome : env.HOME;
  if (platform !== "darwin" || typeof home !== "string" || !home) return [];
  return [path.posix.join(home, "Applications", macBundle(browser))];
}

function firstExisting(files, fileExists) {
  for (var index = 0; index < files.length; index += 1) {
    if (fileExists(files[index])) return files[index];
  }
  return null;
}

function channelBrowserSelection(browser, platform, env, fileExists, options) {
  var args = browser === "chrome" ? [] : ["--browser", "msedge"];
  var system = firstExisting(browserPaths(browser, platform, env), fileExists);
  if (system) return { args: args, executablePath: system };
  var user = firstExisting(userBrowserPaths(browser, platform, env, options), fileExists);
  return user ? { args: args.concat(["--executable-path", user]), executablePath: user } : { args: [], executablePath: null };
}

module.exports = { browserPaths: browserPaths, channelBrowserSelection: channelBrowserSelection, firstExisting: firstExisting };
