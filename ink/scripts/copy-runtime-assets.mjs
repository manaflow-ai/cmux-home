import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "dist", "bin"), { recursive: true });
await cp(resolve(root, "bin", "freestyle-vm-ssh.mjs"), resolve(root, "dist", "bin", "freestyle-vm-ssh.mjs"));
await cp(resolve(root, "bin", "remote-security.mjs"), resolve(root, "dist", "bin", "remote-security.mjs"));
await cp(resolve(root, "remote-artifacts.json"), resolve(root, "dist", "remote-artifacts.json"));
