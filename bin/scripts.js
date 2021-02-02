#!/usr/bin/env node

var querystring = require("query-string");
var command = process.argv[2];
var [script, params = ""] = command.split("?");
var query = querystring.parse(params);
params = Object.keys(query).map((key) =>
  query[key] ? `--${key}=${query[key]}` : `--${key}`
);
var Monodic = require("../lib");
var result;

switch (script) {
  case "start":
    return Monodic.start();
  case "reset":
    return Monodic.reset();
  case "release":
    return Monodic.release();
  case "release-all":
    return Monodic.releaseAll();
  case "command":
    return Monodic.command()
  default:
    console.log('Unknown script "' + script + '".');
    break;
}

if (result) {
  switch (result.signal) {
    case "SIGKILL":
      console.log(
        "The build failed because the process exited too early. " +
          "This probably means the system ran out of memory or someone called " +
          "`kill -9` on the process."
      );
      process.exit(1);
      break;
    case "SIGTERM":
      console.log(
        "The build failed because the process exited too early. " +
          "Someone might have called `kill` or `killall`, or the system could " +
          "be shutting down."
      );
      process.exit(1);
      break;
  }
  process.exit(result.status);
}
