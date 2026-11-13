#!/usr/bin/env node
// parity.mjs <html> [--random N] [--seed S] [--jobs J] [--combos FILE] [--installer DIR]
// Builds install.sh from <html> (scripts/build-installer.mjs) and checks that `bash install.sh --print ...`
// is byte-identical to the page's generate() (file mode) for a broad sample of selections, in both
// argument forms (`<pm> <ids...> [--no-shell]` and `<combo>`). Only --print, --list and --help are run,
// which install nothing. Also checks the error paths (exit 2), --list, --help, the sh bootstrap in file
// mode, and that tools.json and llms.txt match the page.
//   --combos FILE  a saved `gen.mjs --combos` output: every combo in it must still decode to the same
//                  selection (the script for it must match the page's script for its key).
//   --installer DIR  test DIR/install.sh, tools.json and llms.txt (a built site version, e.g. the release's)
//                  instead of building them from <html>; they must also equal a fresh build from <html>.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { load, build } from "./gen.mjs";
import { buildInstaller } from "../scripts/build-installer.mjs";

const args = process.argv.slice(2);
const htmlPath = args.shift();
if (!htmlPath) { console.error("usage: parity.mjs <html> [--random N] [--seed S] [--jobs J] [--combos FILE] [--installer DIR]"); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RANDOM = +opt("--random", 300), SEED = +opt("--seed", 1), JOBS = +opt("--jobs", Math.max(2, os.cpus().length));
const COMBOS = opt("--combos", null), INSTALLER = opt("--installer", null);

const { boots } = load(htmlPath);
const { TOOLS, PM_ORDER } = boots;
const NT = TOOLS.length;
const allIds = TOOLS.map(t => t.id);
const fresh = buildInstaller(htmlPath);
const built = !INSTALLER ? fresh : {
  installSh: fs.readFileSync(path.join(INSTALLER, "install.sh"), "utf8"),
  toolsJson: fs.readFileSync(path.join(INSTALLER, "tools.json"), "utf8"),
  llmsTxt: fs.readFileSync(path.join(INSTALLER, "llms.txt"), "utf8"),
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-"));
const SH = path.join(dir, "install.sh");
fs.writeFileSync(SH, built.installSh);
const fails = [];
if (INSTALLER) for (const k of ["installSh", "toolsJson", "llmsTxt"])
  if (built[k] !== fresh[k]) fails.push(`${INSTALLER}: ${k} differs from a fresh build of ${htmlPath}`);

const run = (cmd, argv) => new Promise(res => {
  execFile(cmd, argv, { maxBuffer: 64 << 20, encoding: "utf8" }, (err, stdout, stderr) =>
    res({ rc: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr }));
});
async function pool(items, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: JOBS }, async () => { while (next < items.length) { const i = next++; await fn(items[i]); } }));
}

// ---- the sample
const cases = [];
const add = (label, pm, ids, rcOn) => cases.push({ label, pm, ids: [...new Set(ids)], rcOn });
for (const pm of PM_ORDER) {
  add("all", pm, allIds, true); add("all", pm, allIds, false);
  for (const t of TOOLS) {
    add(`only:${t.id}`, pm, [t.id], true);
    if (t.init || t.rc || t.requires) add(`only:${t.id}`, pm, [t.id], false);
  }
  const sets = {
    requires: t => t.requires, init: t => t.init, initAlways: t => t.initAlways, initUpstreamOnly: t => t.initUpstreamOnly,
    initLast: t => t.init, fallback: t => t.native && t.fn, noFallback: t => t.noFallback, skip: t => t.skip,
    rc: t => t.rc, build: t => t.build, prepost: t => t.pre || t.post, docker: t => t.id === "docker" || t.requires,
  };
  for (const [name, f] of Object.entries(sets)) {
    const ids = TOOLS.filter(f).map(t => t.id);
    if (ids.length) { add(`set:${name}`, pm, ids, true); add(`set:${name}`, pm, ids, false); }
  }
}
let s = SEED >>> 0; // mulberry32
const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
for (let n = 0; n < RANDOM; n++) {
  const pm = PM_ORDER[Math.floor(rnd() * PM_ORDER.length)], p = [0.03, 0.1, 0.3, 0.7][n % 4];
  let ids = allIds.filter(() => rnd() < p);
  if (!ids.length) ids = [allIds[Math.floor(rnd() * NT)]];
  add(`random#${n}`, pm, ids, rnd() < 0.7);
}

// ---- run
let runs = 0;
const firstDiff = (a, b) => {
  const A = a.split("\n"), B = b.split("\n");
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) return `line ${i + 1}: page ${JSON.stringify(B[i])} vs install.sh ${JSON.stringify(A[i])}`;
  return "same lines, different bytes";
};
async function check(c) {
  const picked = new Set(c.ids);
  const empty = boots.resolve(picked, c.pm).active.size === 0;
  const want = empty ? "" : build(boots, c.pm, c.ids, { rcOn: c.rcOn });
  const combo = boots.encode(c.pm, picked, !c.rcOn);
  const forms = [["--print", c.pm, ...c.ids, ...(c.rcOn ? [] : ["--no-shell"])], ["--print", combo]];
  if (c.combo) forms.splice(0, 2, ["--print", c.combo]);
  for (const argv of forms) {
    const r = await run("bash", [SH, ...argv]); runs++;
    const tag = `${c.label} ${c.pm} rc-${c.rcOn ? "on" : "off"} [${argv.slice(1, 4).join(" ")}${argv.length > 4 ? " ..." : ""}]`;
    if (empty) {
      if (r.rc !== 2 || r.stdout) fails.push(`${tag}: nothing installable, want exit 2 and no output, got exit ${r.rc} (${r.stdout.length} bytes)`);
    } else if (r.rc !== 0) fails.push(`${tag}: exit ${r.rc}: ${r.stderr.trim()}`);
    else if (r.stdout !== want) fails.push(`${tag}: ${firstDiff(r.stdout, want)}`);
  }
}
if (COMBOS) {
  const saved = JSON.parse(fs.readFileSync(COMBOS, "utf8")).combos;
  for (const [key, combo] of Object.entries(saved)) {
    const [pm, rc, rest] = key.split("|"), eq = rest.indexOf("=");
    const ids = rest.slice(eq + 1) ? rest.slice(eq + 1).split(",") : [];
    const now = boots.encode(pm, new Set(ids), rc === "rc-off");
    if (now !== combo) fails.push(`saved combo ${key}: was ${combo}, the page now encodes ${now}`);
    cases.push({ label: `saved:${rest.slice(0, eq)}`, pm, ids, rcOn: rc === "rc-on", combo });
  }
}
await pool(cases, check);

// error paths, --list, --help, sh bootstrap (file mode); all install nothing
const SITE = boots.SITE;
const tooNew = (pm, extra) => pm + "-" + ((1n << BigInt(NT + extra)) | 2n).toString(36);
const expectErr = async (argv, rc, re) => {
  const r = await run("bash", [SH, ...argv]); runs++;
  if (r.rc !== rc || !re.test(r.stderr) || r.stdout) fails.push(`${argv.join(" ")}: want exit ${rc} and stderr ~ ${re}, got exit ${r.rc}: ${r.stderr.trim().split("\n").pop()}`);
};
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
await expectErr(["--print", tooNew("apt", 1)], 2, new RegExp(esc(`this combo needs a newer version: ${SITE}install.sh`)));
await expectErr(["--print", tooNew("dnf", 40)], 2, /needs a newer version/);
await expectErr(["--print", "apt", "nodejs"], 2, /unknown tool id 'nodejs'; did you mean: node/);
await expectErr(["--print", "apt", "git", "zzzzqqq"], 2, /unknown tool id 'zzzzqqq'/);
await expectErr(["--print", "ubuntu", "git"], 2, /for ubuntu use: apt/);
await expectErr(["--print", "git", "jq"], 2, /start with the package manager/);
await expectErr(["--print", "apt"], 2, /no tools given/);
await expectErr(["--print", "apt-0"], 2, /picks no tools/);
await expectErr(["--print", "apt-Q1"], 2, /not a combo ID/);
await expectErr(["--print", "apt-12", "git"], 2, /takes no tool ids/);
await expectErr(["--print", "apt-docker"], 2, /'apt-docker' is not a combo ID; did you mean: .*bash -s -- apt docker/);
// combos whose digits spell a tool id or name: install.sh refuses them as typos, the page writes them
// with a 0 after the dash (safeCombo), and that form must decode to the same selection
{
  const words = [...new Set(TOOLS.flatMap(t => [t.id, t.name.toLowerCase()]))].filter(w => /^[0-9a-z]+$/.test(w));
  let n = 0;
  for (const pm of ["apt", "apk"]) for (const w of words) {
    const d = boots.decode(`${pm}-${w}`);
    if (!d || d.newer || !d.picked.size || !boots.resolve(d.picked, pm).active.size) continue;
    const ids = [...d.picked], rcOn = !d.rcOff, combo = boots.encode(pm, d.picked, d.rcOff);
    if (combo !== `${pm}-${w}`) { fails.push(`${pm}-${w} re-encodes as ${combo}`); continue; }
    if (boots.safeCombo(combo) !== `${pm}-0${w}`) fails.push(`page safeCombo(${combo}) is ${boots.safeCombo(combo)}`);
    await expectErr(["--print", combo], 2, /is not a combo ID; did you mean/);
    cases.push({ label: `spells:${w}`, pm, ids, rcOn, combo: `${pm}-0${w}` });
    n++;
  }
  await pool(cases.slice(-n), check);
  if (n < 10) fails.push(`only ${n} combos spelling a tool id were checked`);
}
await expectErr(["--print", "--list"], 2, /don't go together/);
await expectErr(["--print", "--frobnicate", "apt", "git"], 2, /unknown option/);
{
  const r = await run("bash", [SH, "--list"]); runs++;
  const listed = r.stdout.split("\n").slice(1).filter(Boolean).map(l => l.split(/\s+/)[0]);
  if (r.rc !== 0 || listed.length !== NT || allIds.some(id => !listed.includes(id))) fails.push(`--list: exit ${r.rc}, ${listed.length} rows for ${NT} tools`);
  for (const pm of PM_ORDER) {
    const r2 = await run("bash", [SH, "--list", pm]); runs++;
    const rows = r2.stdout.split("\n").slice(1).filter(Boolean);
    const unav = rows.filter(l => /  unavailable: /.test(l)).length;
    const want = TOOLS.filter(t => boots.how(t, pm).type === "skip").length;
    if (r2.rc !== 0 || rows.length !== NT || unav !== want) fails.push(`--list ${pm}: exit ${r2.rc}, ${rows.length} rows, ${unav} unavailable (want ${want})`);
  }
  const h = await run("bash", [SH, "--help"]); runs++;
  if (h.rc !== 0 || !/Usage: /.test(h.stdout)) fails.push(`--help: exit ${h.rc}`);
  // POSIX bootstrap, run as a file under sh: --help is printed by sh itself, --print goes on under bash
  const hs = await run("sh", [SH, "--help"]); runs++;
  if (hs.rc !== 0 || hs.stdout !== h.stdout) fails.push(`sh install.sh --help: exit ${hs.rc}, differs from bash's`);
  const ps = await run("sh", [SH, "--print", "apt", "git", "jq"]); runs++;
  if (ps.rc !== 0 || ps.stdout !== build(boots, "apt", ["git", "jq"])) fails.push(`sh install.sh --print apt git jq: exit ${ps.rc}, not the page's script`);
}

// tools.json and llms.txt agree with the page
{
  const m = JSON.parse(built.toolsJson);
  if (m.version !== boots.VERSION || m.commit !== boots.COMMIT) fails.push("tools.json: version/commit differ from the page");
  if (m.tools.length !== NT) fails.push(`tools.json: ${m.tools.length} tools, page has ${NT}`);
  const via = { pkg: "pkg", fn: "upstream", rc: "shell", skip: "unavailable" };
  m.tools.forEach((t, i) => {
    if (t.id !== allIds[i] || t.index !== i || t.bit !== i + 1) fails.push(`tools.json: tools[${i}] is ${t.id} (index ${t.index}, bit ${t.bit})`);
    for (const pm of PM_ORDER) {
      const T = TOOLS[i], h = boots.how(T, pm), e = t.pm[pm];
      if (!e || e.method !== via[h.type] || e.via !== h.via) fails.push(`tools.json: ${t.id} on ${pm}: ${JSON.stringify(e)} vs how() ${h.type}/${h.via}`);
      // fallback: the upstream install behind a distro package; null where it exists but can't be used (noFallback)
      const up = T.fn && (T.fn[pm] || T.fn["*"]);
      const want = h.type !== "pkg" || !up ? undefined : h.fb ? JSON.stringify({ via: boots.VIA[h.fb], method: "upstream" }) : "null";
      const got = e && "fallback" in e ? JSON.stringify(e.fallback) : undefined;
      if (got !== want) fails.push(`tools.json: ${t.id} on ${pm}: fallback ${got} (want ${want})`);
    }
  });
  const grouped = m.groups.flatMap(g => g.tools);
  if (grouped.length !== NT || allIds.some(id => !grouped.includes(id))) fails.push("tools.json: groups do not list every tool once");
  for (const id of allIds) if (!new RegExp(`(: |, )${id}\\b`).test(built.llmsTxt)) fails.push(`llms.txt: no tool id ${id}`);
}

fs.rmSync(dir, { recursive: true, force: true });
const n = cases.length;
console.log(`parity: ${n} selections (${PM_ORDER.length} pms, ${NT} tools; ${RANDOM} random, seed ${SEED}${COMBOS ? `, ${Object.keys(JSON.parse(fs.readFileSync(COMBOS, "utf8")).combos).length} saved combos` : ""}), ${runs} install.sh runs, ${fails.length} failures`);
fails.slice(0, 30).forEach(f => console.log("  FAIL " + f));
if (fails.length > 30) console.log(`  ... and ${fails.length - 30} more`);
console.log(fails.length ? "PARITY FAILED" : "PARITY OK");
process.exit(fails.length ? 1 : 0);
