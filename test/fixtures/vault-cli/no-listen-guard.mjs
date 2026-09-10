/**
 * Records every attempt to open a listening socket in the process that loads it.
 *
 * Loaded into the `sb-docs` child process via `NODE_OPTIONS=--import`, so the
 * vault CLI e2e suite can assert that a CLI invocation opens no MCP, HTTP or
 * worker listener. `http.Server`, `https.Server` and Fastify all inherit
 * `net.Server.prototype.listen`, so patching it here covers every listener the
 * upstream server entry points can start.
 *
 * Writes one JSON line per call to the file named by `SB_DOCS_LISTEN_LOG`.
 */

import fs from "node:fs";
import net from "node:net";

const logPath = process.env.SB_DOCS_LISTEN_LOG;
const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function recordListen(...args) {
  if (logPath) {
    const serialized = args.map((arg) => (typeof arg === "function" ? "[function]" : arg));
    fs.appendFileSync(logPath, `${JSON.stringify(serialized)}\n`, "utf8");
  }
  return originalListen.apply(this, args);
};
