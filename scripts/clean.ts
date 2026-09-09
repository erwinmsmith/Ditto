import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];
if (name !== "dist" && name !== ".test-dist") throw new Error("Only generated output directories may be cleaned");
const target = resolve(root, name);
if (dirname(target) !== root) throw new Error("Output must be directly inside this repository");
rmSync(target, { recursive: true, force: true });
