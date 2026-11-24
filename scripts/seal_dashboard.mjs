// Encrypt data.json, history.json, notes.json, and qa.json into vault/*.bin.
// The password is read from BAPS_DASHBOARD_PASSWORD or .dashboard-password
// (that file is gitignored). A missing password file gets a new one.
import { createCipheriv, pbkdf2Sync, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const PASS_FILE = ".dashboard-password";
const ITERATIONS = 150000;
const WORDS = ["amber", "cedar", "delta", "ember", "flint", "grove", "harbor", "ivory", "juniper", "kelp", "lotus", "maple", "north", "otter", "pebble", "quartz", "river", "spruce", "timber", "violet"];

function password() {
  if (process.env.BAPS_DASHBOARD_PASSWORD) return process.env.BAPS_DASHBOARD_PASSWORD;
  if (existsSync(PASS_FILE)) return readFileSync(PASS_FILE, "utf8").trim();
  const made = [0, 1, 2].map(() => WORDS[randomInt(WORDS.length)]).join("-") + "-" + randomInt(100, 1000);
  writeFileSync(PASS_FILE, made + "\n", { mode: 0o600 });
  console.log("New password written to .dashboard-password (not committed).");
  return made;
}

const pass = password();
if (!pass) {
  console.error("No password available.");
  process.exit(1);
}

const salt = randomBytes(16);
const key = pbkdf2Sync(pass, salt, ITERATIONS, 32, "sha256");
mkdirSync("vault", { recursive: true });

for (const name of ["data", "history", "notes", "qa"]) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(readFileSync(name + ".json")), cipher.final(), cipher.getAuthTag()]);
  writeFileSync("vault/" + name + ".bin", Buffer.concat([Buffer.from("BAPS1"), salt, iv, enc]));
  console.log("vault/" + name + ".bin");
}
