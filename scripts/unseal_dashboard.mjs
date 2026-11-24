// Write data.json, history.json, notes.json, and qa.json back from vault/*.bin.
// Used before a weekly update on a fresh checkout. Password: BAPS_DASHBOARD_PASSWORD
// or .dashboard-password.
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PASS_FILE = ".dashboard-password";
const ITERATIONS = 150000;
const pass = process.env.BAPS_DASHBOARD_PASSWORD || (existsSync(PASS_FILE) ? readFileSync(PASS_FILE, "utf8").trim() : "");
if (!pass) {
  console.error("Set BAPS_DASHBOARD_PASSWORD or create .dashboard-password.");
  process.exit(1);
}

for (const name of ["data", "history", "notes", "qa"]) {
  const buf = readFileSync("vault/" + name + ".bin");
  if (buf.subarray(0, 5).toString() !== "BAPS1") {
    console.error("vault/" + name + ".bin is not a dashboard vault.");
    process.exit(1);
  }
  const salt = buf.subarray(5, 21);
  const iv = buf.subarray(21, 33);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(33, buf.length - 16);
  const key = pbkdf2Sync(pass, salt, ITERATIONS, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  writeFileSync(name + ".json", Buffer.concat([decipher.update(enc), decipher.final()]));
  console.log(name + ".json");
}
