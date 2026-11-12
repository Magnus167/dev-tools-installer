#!/usr/bin/env node
// Generate install scripts from the installer HTML without a browser.
// usage: gen.mjs <html> <pm> [--rc-off] [--paste] <ids...|all>
//        gen.mjs <html> --list
//        gen.mjs <html> --combos [--base N]
//        gen.mjs <html> --dump <dir>      (lint helper: writes <dir>/<pm>/{all,all-norc,<id>}.sh)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export function load(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const snips = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m, app = null;
  while ((m = re.exec(html))) {
    const attrs = m[1], sn = /data-snip="([^"]+)"/.exec(attrs);
    if (sn) snips.push({ name: sn[1], text: m[2] });
    else if (!/\bsrc=/.test(attrs) && !/type="text\/plain"/.test(attrs)) app = m[2];
  }
  if (!app) throw new Error("no app <script> found in " + htmlPath);
  const noop = () => undefined;
  const stub = () => new Proxy({
    innerHTML: "", textContent: "", value: "", checked: false, disabled: false,
    dataset: {}, style: {}, classList: { toggle: noop, add: noop, remove: noop },
    addEventListener: noop, setAttribute: noop, appendChild: noop, remove: noop,
    querySelector: () => stub(), querySelectorAll: () => [],
  }, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) });
  const document = {
    querySelectorAll: sel => sel === "script[data-snip]"
      ? snips.map(s => ({ dataset: { snip: s.name }, textContent: s.text })) : [],
    querySelector: () => stub(),
    createElement: () => stub(), body: stub(),
  };
  const ctx = { document, location: { hash: "", replace: noop }, navigator: {}, getSelection: noop,
    setTimeout, console };
  ctx.window = ctx; ctx.addEventListener = noop;
  vm.createContext(ctx);
  vm.runInContext(app, ctx, { filename: htmlPath + "#app" });
  if (!ctx.__boots) throw new Error("window.__boots not exposed");
  return { boots: ctx.__boots, snipNames: snips.map(s => s.name), snips };
}

export function build(boots, pm, ids, { rcOn = true, paste = false } = {}) {
  const picked = new Set(ids);
  const combo = boots.encode(pm, picked, !rcOn);
  const script = boots.generate(pm, picked, rcOn, combo);
  return paste ? boots.pasteWrap(pm, script) : script;
}

function die(msg) { console.error(msg); process.exit(2); }

if (import.meta.url === "file://" + process.argv[1] || (process.argv[1] || "").endsWith("gen.mjs")) {
  const args = process.argv.slice(2);
  const htmlPath = args.shift();
  if (!htmlPath) die("usage: gen.mjs <html> <pm> [--rc-off] [--paste] <ids...|all> | --list | --combos | --dump DIR");
  const { boots, snipNames, snips } = load(htmlPath);
  const allIds = boots.TOOLS.map(t => t.id);
  const pms = Object.keys(boots.PM);

  if (args[0] === "--list") {
    console.log(allIds.join("\n"));
  } else if (args[0] === "--combos") {
    let base = 22;
    const bi = args.indexOf("--base"); if (bi >= 0) base = +args[bi + 1];
    base = Math.min(base, allIds.length);
    const baseIds = allIds.slice(0, base);
    const sels = {
      ...Object.fromEntries(baseIds.map(id => ["only:" + id, [id]])),
      "base-all": baseIds,
      "base-even": baseIds.filter((_, i) => i % 2 === 0),
      "base-odd": baseIds.filter((_, i) => i % 2 === 1),
      "none": [],
    };
    const combos = {}; const fails = []; let checked = 0;
    const rt = (pm, ids, rcOff) => {
      const c = boots.encode(pm, new Set(ids), rcOff);
      const d = boots.decode(c); checked++;
      const same = d && d.pm === pm && d.rcOff === rcOff && d.picked.size === ids.length && ids.every(i => d.picked.has(i));
      if (!same) fails.push(c);
      return c;
    };
    for (const pm of pms) for (const [n, ids] of Object.entries(sels)) for (const rcOff of [false, true])
      combos[`${pm}|${rcOff ? "rc-off" : "rc-on"}|${n}=${ids.join(",")}`] = rt(pm, ids, rcOff);
    // round-trip on the current full list, including tools beyond the baseline
    for (const pm of pms) {
      rt(pm, allIds, false); rt(pm, allIds, true);
      allIds.forEach(id => rt(pm, [id], false));
    }
    const dup = allIds.filter((x, i) => allIds.indexOf(x) !== i);
    console.log(JSON.stringify({ baseCount: base, toolCount: allIds.length, combos,
      roundtrip: { checked, failures: fails, duplicateIds: dup, ok: !fails.length && !dup.length } }, null, 1));
    if (fails.length || dup.length) process.exit(1);
  } else if (args[0] === "--dump") {
    const dir = args[1]; if (!dir) die("--dump needs a dir");
    let errors = 0;
    const referenced = new Set();
    for (const t of boots.TOOLS) {
      [t.fn, t.pre, t.post].forEach(o => o && Object.values(o).forEach(v => referenced.add(v)));
      if (t.rc) referenced.add(t.rc);
      if (t.init) referenced.add(t.init);
    }
    for (const s of referenced) if (!snipNames.includes(s)) { console.error(`MISSING SNIPPET (referenced by TOOLS): ${s}`); errors++; }
    // structural checks on the registry
    const snipText = Object.fromEntries(snips.map(s => [s.name, s.text]));
    for (const t of boots.TOOLS) {
      for (const k of new Set(Object.values(t.fn || {}))) {
        if (snipText[k] !== undefined && !new RegExp(`^install_${t.id}\\(\\) \\{`, "m").test(snipText[k])) {
          console.error(`SNIPPET ${k} does not define install_${t.id}() (generate() calls it by the tool id)`); errors++;
        }
        if (boots.VIA && !boots.VIA[k]) { console.error(`NO VIA BADGE for snippet ${k} (${t.id})`); errors++; }
      }
      for (const pm of pms) {
        try { boots.how(t, pm); } catch (e) { console.error(`HOW FAILED ${t.id} on ${pm}: ${e.message}`); errors++; }
      }
      if (t.skip) for (const pm of Object.keys(t.skip)) if (!pms.includes(pm)) { console.error(`SKIP for unknown pm ${pm} on ${t.id}`); errors++; }
      // a tool whose requirement is unavailable on a pm must be unavailable there too, and must not
      // drag anything into the script
      for (const pm of pms) {
        let h; try { h = boots.how(t, pm); } catch (e) { continue; }
        for (const r of t.requires || []) {
          const rt = boots.TOOLS.find(x => x.id === r);
          if (!rt) { console.error(`${t.id} requires unknown tool ${r}`); errors++; continue; }
          if (boots.how(rt, pm).type === "skip" && h.type !== "skip") {
            console.error(`REQUIRES-SKIP ${t.id} on ${pm}: needs ${r}, which is unavailable there, but ${t.id} is not marked unavailable`); errors++;
          }
        }
        if (h.type === "skip") {
          const s = build(boots, pm, [t.id]);
          if (/^(step|fallback) /m.test(s) || /^if ! pm_install /m.test(s)) { console.error(`SKIPPED ${t.id} on ${pm} still installs something`); errors++; }
        }
      }
    }
    if (boots.GROUPS) {
      const seen = {};
      for (const [g, ids] of boots.GROUPS) for (const id of ids) {
        const t = boots.TOOLS.find(x => x.id === id);
        if (!t) { console.error(`GROUPS lists unknown tool ${id}`); errors++; continue; }
        if (t.group !== g) { console.error(`GROUP MISMATCH ${id}: TOOLS says "${t.group}", GROUPS has it under "${g}"`); errors++; }
        seen[id] = (seen[id] || 0) + 1;
      }
      for (const id of allIds) if (seen[id] !== 1) { console.error(`TOOL ${id} appears ${seen[id] || 0} times in GROUPS (want 1)`); errors++; }
    }
    for (const pm of pms) {
      fs.mkdirSync(path.join(dir, pm), { recursive: true });
      const jobs = [["all", allIds, true], ["all-norc", allIds, false], ...allIds.map(id => [id, [id], true])];
      for (const [name, ids, rcOn] of jobs) {
        try { fs.writeFileSync(path.join(dir, pm, name + ".sh"), build(boots, pm, ids, { rcOn })); }
        catch (e) { console.error(`GENERATE FAILED ${pm}/${name}: ${e.message}`); errors++; }
      }
    }
    process.exit(errors ? 1 : 0);
  } else {
    const pm = args.shift();
    if (!boots.PM[pm]) die(`unknown pm '${pm}' (one of ${pms.join(" ")})`);
    let rcOn = true, paste = false; const ids = [];
    for (const a of args) {
      if (a === "--rc-off") rcOn = false; else if (a === "--paste") paste = true;
      else if (a === "all") ids.push(...allIds); else ids.push(a);
    }
    const bad = ids.filter(i => !allIds.includes(i));
    if (bad.length) die("unknown tool id(s): " + bad.join(" "));
    if (!ids.length) die("no tool ids given (use ids or 'all')");
    process.stdout.write(build(boots, pm, ids, { rcOn, paste }));
  }
}
