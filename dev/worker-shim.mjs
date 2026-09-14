// Runs scripts/leveldb/worker.js inside a Node worker_thread by emulating the tiny part of the browser Worker
// global scope it uses (self.addEventListener("message"), self.postMessage). Developer tooling only.
import { parentPort, workerData } from "node:worker_threads";
globalThis.self = {
  addEventListener: (type, fn) => {
    if ( type === "message" ) parentPort.on("message", data => fn({ data }));
  },
  postMessage: message => parentPort.postMessage(message)
};
await import(workerData.url);
