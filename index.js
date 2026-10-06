// pi extension entry: the package root index is shown by pi as "pi-durable-subagents".
// An npm install ships the compiled dist/. A git install (`pi install git:github.com/purboo/pi-durable-subagents`)
// has no build step, so it runs the TypeScript sources directly (Node >= 22.19 runs .ts outside node_modules).
import { existsSync } from "node:fs";

const dist = new URL("./dist/agent/extension.js", import.meta.url);
const { default: extension } = await import(existsSync(dist) ? dist.href : new URL("./src/agent/extension.ts", import.meta.url).href);
export default extension;
