import { parentPort } from "node:worker_threads";
import { processLines } from "./morphology.js";

parentPort.on("message", ({ lines, opts }) => {
  parentPort.postMessage(processLines(lines, opts));
});
