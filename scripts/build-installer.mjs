#!/usr/bin/env node
// build-installer.mjs <index.html> <outdir>
// Builds <outdir>/install.sh, <outdir>/tools.json and <outdir>/llms.txt from the page (Node stdlib only).
// The page stays the single source of truth: this evaluates its app script up to the
// `window.__boots = {...}` line (data + generator, none of the UI) and takes the tool table,
// package managers, snippets, version and commit from there. install.sh is scripts/install.sh.in
// with that data filled in; its bash port of generate() is checked against the page by tests/parity.mjs.
// Run it on a page that build-site.sh has already stamped, so the version and commit are real.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- load the page
export function loadPage(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const snips = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m, app = null;
  while ((m = re.exec(html))) {
    const attrs = m[1], sn = /data-snip="([^"]+)"/.exec(attrs);
    if (sn) snips.push({ name: sn[1], text: m[2] });
    else if (!/\bsrc=/.test(attrs) && /^\s*window\.__boots\s*=/m.test(m[2])) app = m[2];
  }
  if (!app) throw new Error(`no app <script> with a window.__boots line in ${htmlPath}`);
  if (!/^\s*\(function\s*\(\)\s*\{/.test(app)) throw new Error("the app script is expected to be one (function () { ... })() block");
  // evaluate the data and generator part only: through the window.__boots line, then close the IIFE
  const lines = app.split("\n");
  const k = lines.findIndex(l => /^\s*window\.__boots\s*=/.test(l));
  if (!/;\s*$/.test(lines[k])) throw new Error("the window.__boots = {...}; assignment must be on one line");
  const code = lines.slice(0, k + 1).join("\n") + "\n})();\n";
  const noop = () => undefined;
  const document = {
    querySelectorAll: sel => sel === "script[data-snip]"
      ? snips.map(s => ({ dataset: { snip: s.name }, textContent: s.text })) : [],
    querySelector: () => null, getElementById: () => null,
  };
  const ctx = { document, location: { hash: "", replace: noop }, navigator: {}, console, setTimeout };
  ctx.window = ctx; ctx.addEventListener = noop;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: htmlPath + "#app" });
  if (!ctx.__boots) throw new Error("window.__boots not exposed");
  return { boots: ctx.__boots, snipNames: snips.map(s => s.name), snips };
}

// ---------------------------------------------------------------- helpers
const q = s => {
  s = String(s ?? "");
  return /^[A-Za-z0-9_.\/+-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
};
function bashArray(name, values, comment) {
  const out = comment ? [`# ${comment}`] : [];
  let cur = `${name}=(`;
  for (const v of values.map(q)) {
    const open = cur.endsWith("(");
    if (!open && cur.length + 1 + v.length > 110) { out.push(cur); cur = "  " + v; }
    else cur += (open ? "" : " ") + v;
  }
  out.push(cur + ")");
  return out.join("\n");
}
function fail(msg) { throw new Error("build-installer: " + msg); }

// ---------------------------------------------------------------- build
export function buildInstaller(htmlPath) {
  const { boots: B } = loadPage(htmlPath);
  const need = ["generate", "encode", "how", "resolve", "skipReason", "TOOLS", "PM", "PM_ORDER", "PM_SHOWN", "GROUPS",
    "VIA", "SNIP", "VERSION", "COMMIT", "COMMIT_SHORT", "SITE", "SITE_HERE", "REPO"];
  for (const k of need) if (B[k] === undefined) fail(`window.__boots has no ${k}`);
  const { TOOLS, PM, PM_ORDER, PM_SHOWN, GROUPS, VIA, SNIP, VERSION, COMMIT, COMMIT_SHORT, SITE, SITE_HERE, REPO } = B;
  if (!/^(v\d+\.\d+\.\d+|dev)$/.test(VERSION)) fail(`odd VERSION ${VERSION}`);
  if (!/^([0-9a-f]{40}|dev)$/.test(COMMIT)) fail(`odd COMMIT ${COMMIT}`);
  const idx = Object.fromEntries(TOOLS.map((t, i) => [t.id, i]));
  // what the bash side relies on: plain ids (unquoted in the script), ASCII names (wrapList counts bytes there)
  for (const t of TOOLS) {
    if (!/^[a-z0-9]+$/.test(t.id)) fail(`tool id ${t.id} is not [a-z0-9]+`);
    if (!/^[\x20-\x7e]+$/.test(t.name)) fail(`tool name ${t.name} is not printable ASCII`);
    if (t.bin && !/^[A-Za-z0-9_.+-]+$/.test(t.bin)) fail(`odd bin ${t.bin}`);
    for (const r of t.requires || []) if (!(r in idx)) fail(`${t.id} requires unknown ${r}`);
    for (const s of [t.rc, t.init]) if (s && !(s in SNIP)) fail(`${t.id}: no snippet ${s}`);
  }
  for (const p of PM_ORDER) if (!/^[a-z]+$/.test(p) || !PM[p]) fail(`odd pm ${p}`);
  for (const s of ["preamble", "helpers", "pm-install", "fallback", "rc-head", "rc-path", "docker-group"])
    if (!(s in SNIP)) fail(`no snippet ${s}`);

  const ids = TOOLS.map(t => t.id);
  const example = (pm, list, rcOff = false) => B.encode(pm, new Set(list), rcOff);
  const exCombo = example("apt", ["git", "jq", "fd"].filter(id => id in idx));
  const selfUrl = SITE_HERE + "install.sh";

  // ---- data section of install.sh
  const D = [];
  D.push(`BOOTS_VERSION=${q(VERSION)}`, `BOOTS_COMMIT_SHORT=${q(COMMIT_SHORT)}`,
    `BOOTS_SITE=${q(SITE)}`, `BOOTS_SITE_HERE=${q(SITE_HERE)}`, `BOOTS_REPO=${q(REPO)}`, "");
  D.push(bashArray("PM_IDS", PM_ORDER, "package managers: the combo prefixes"));
  D.push(bashArray("PM_LIST", PM_SHOWN, "the same, in display order"));
  D.push(bashArray("PM_DISTROS", PM_ORDER.map(p => PM[p].distros), "distros per package manager, in PM_IDS order"), "");
  D.push("# tools, in TOOLS order: index i is combo bit i+1");
  D.push(bashArray("T_ID", ids));
  D.push(bashArray("T_NAME", TOOLS.map(t => t.name)));
  D.push(bashArray("T_BIN", TOOLS.map(t => t.bin || "")));
  D.push(bashArray("T_GROUP", TOOLS.map(t => t.group)));
  D.push(bashArray("T_DESC", TOOLS.map(t => t.desc)));
  D.push(bashArray("T_HAY", TOOLS.map(t => [t.id, t.name, t.bin || ""].join(" ").toLowerCase()), "lowercase id, name and binary, for suggestions"));
  D.push(bashArray("T_REQ", TOOLS.map(t => (t.requires || []).map(r => idx[r]).join(" ")), "indices of the tools each one requires"));
  D.push(bashArray("T_BUILD", TOOLS.map(t => (t.build ? "1" : "")), "1: needs the compiler toolchain"));
  D.push(bashArray("T_INIT", TOOLS.map(t => t.init || ""), "shell hook snippet and its flags (initAlways, initUpstreamOnly, initLast)"));
  D.push(bashArray("T_INITALWAYS", TOOLS.map(t => (t.initAlways ? "1" : ""))));
  D.push(bashArray("T_INITUP", TOOLS.map(t => (t.initUpstreamOnly ? "1" : ""))));
  D.push(bashArray("T_INITLAST", TOOLS.map(t => (t.initLast ? "1" : ""))));
  D.push(bashArray("T_RC", TOOLS.map(t => t.rc || ""), "shell function snippet, for shell-only tools"));
  D.push(`T_DOCKER=${"docker" in idx ? idx.docker : "''"}`, "");
  D.push("# page order of groups, with the tool indices in each");
  D.push(bashArray("G_NAME", GROUPS.map(g => g[0])));
  D.push(bashArray("G_TOOLS", GROUPS.map(g => g[1].map(id => { if (!(id in idx)) fail(`GROUPS has unknown ${id}`); return idx[id]; }).join(" "))), "");

  D.push("# pm_load <pm>: the package manager's commands, and how() of every tool with it (H_*, TOOLS order)");
  D.push("pm_load() {", "  case $1 in");
  const jsonPm = {};
  for (const pm of PM_ORDER) {
    const P = PM[pm];
    const H = TOOLS.map(t => B.how(t, pm));
    for (const [i, h] of H.entries()) {
      for (const s of [h.snip, h.fb, TOOLS[i].pre?.[pm], TOOLS[i].post?.[pm]]) if (s && !(s in SNIP)) fail(`${TOOLS[i].id} on ${pm}: no snippet ${s}`);
      if (h.type === "pkg" && !/^[A-Za-z0-9_.+-]+( [A-Za-z0-9_.+-]+)*$/.test(h.pkgs)) fail(`odd package list ${h.pkgs}`);
    }
    const ind = s => s.split("\n").map(l => "      " + l).join("\n");
    D.push(`    ${pm})`);
    D.push(ind([`P_ID=${pm}`, `P_DISTROS=${q(P.distros)}`, `P_REFRESH=${q(P.refresh)}`, `P_INSTALL=${q(P.install)}`,
      `P_BASE=${q(P.base)}`, `P_BUILD=${q(P.build)}`].join("\n")));
    D.push(ind(bashArray("H_TYPE", H.map(h => h.type))));
    D.push(ind(bashArray("H_VIA", H.map(h => h.via))));
    D.push(ind(bashArray("H_PKGS", H.map(h => h.pkgs || ""))));
    D.push(ind(bashArray("H_FB", H.map(h => h.fb || ""))));
    D.push(ind(bashArray("H_FBVIA", H.map(h => (h.fb ? VIA[h.fb] : "")))));
    D.push(ind(bashArray("H_FN", H.map(h => (h.type === "fn" ? h.snip : "")))));
    D.push(ind(bashArray("H_PRE", TOOLS.map(t => t.pre?.[pm] || ""))));
    D.push(ind(bashArray("H_POST", TOOLS.map(t => t.post?.[pm] || ""))));
    D.push(ind(bashArray("H_WHY", TOOLS.map(t => B.skipReason(t, pm)))));
    D.push("      ;;");
    jsonPm[pm] = H;
  }
  D.push("    *) return 1 ;;", "  esac", "}", "");
  D.push("snip() { # snip <name>: the snippet's text, exactly as the page uses it, in REPLY", "  case $1 in");
  for (const [name, text] of Object.entries(SNIP)) D.push(`    ${q(name)}) REPLY=${q(text)} ;;`);
  D.push('    *) echo "install.sh: internal error: no snippet $1" >&2; exit 3 ;;', "  esac", "}");

  // ---- help (POSIX: the sh bootstrap prints it too)
  const w = Math.max(...PM_SHOWN.map(p => p.length));
  const help = [
    `dev-tools-installer ${VERSION} (commit ${COMMIT_SHORT}): developer tools for Linux, installed with`,
    `your distro's package manager plus official upstream releases where needed.`,
    `Page:   ${SITE_HERE}`,
    `Source: ${REPO}`,
    ``,
    `Usage:  curl -fsSL ${selfUrl} | bash -s -- ARGS`,
    `        (on Alpine, which has no bash, pipe into sh instead: it installs bash first)`,
    ``,
    `ARGS`,
    `  <combo>                          install a selection made on the page, e.g. ${exCombo}`,
    `                                   (the page link for it is ${SITE_HERE}#${exCombo})`,
    `  <pm> <tool-id>... [--no-shell]   install these tools with this package manager`,
    `  --print <combo | pm tool-id...>  print the generated script and exit; nothing is installed`,
    `  --list [pm]                      list the tool ids; with a pm, how each one installs there`,
    `  --help                           show this help`,
    ``,
    `  --no-shell   leave PATH and tool hooks out of ~/.bashrc or ~/.zshrc (nvm and SDKMAN setup`,
    `               and shell functions such as mkcd still go in)`,
    `  <pm>         ${PM_SHOWN.map(p => p.padEnd(w) + "  " + PM[p].distros).join("\n               ")}`,
    ``,
    `Examples`,
    `  curl -fsSL ${selfUrl} | bash -s -- apt git docker node`,
    `  curl -fsSL ${selfUrl} | bash -s -- --print dnf ripgrep fd bat`,
    `  curl -fsSL ${selfUrl} | sh -s -- apk git jq`,
    ``,
    `It builds the same script the page shows for that selection, saves it to a temp file and runs it.`,
    `Read it first (--print). System packages need root, sudo or doas; everything else goes under $HOME`,
    `(mostly ~/.local/bin), Go in /usr/local/go. Re-running is safe: installed tools are skipped.`,
    ``,
    `Exit status: 0 done; 1 something did not install (the script's summary says what);`,
    `2 bad arguments, or a combo made by a newer version (nothing was changed).`,
    `BOOTS_INSTALL_URL overrides where "| sh" fetches this installer again under bash`,
    `(default ${selfUrl}).`,
  ].join("\n");
  if (/^BOOTS_HELP$/m.test(help)) fail("help text contains the here-doc delimiter");

  const tpl = fs.readFileSync(path.join(HERE, "install.sh.in"), "utf8");
  const fill = { "@VERSION@": VERSION, "@COMMIT@": COMMIT, "@SELF_URL@": selfUrl, "@SITE_HERE@": SITE_HERE,
    "@REPO@": REPO, "@HELP@": help, "@DATA@": D.join("\n") };
  let installSh = tpl.replace(/@[A-Z_]+@/g, k => { if (!(k in fill)) fail(`unknown placeholder ${k} in install.sh.in`); return fill[k]; });

  // ---- tools.json
  const method = { pkg: "pkg", fn: "upstream", rc: "shell", skip: "unavailable" };
  const manifest = {
    version: VERSION, commit: COMMIT, site: SITE_HERE, repo: REPO,
    combo: {
      format: "<pm>-<base36 bitmask>",
      bit0: "set = shell wiring off (--no-shell)",
      note: "bit i+1 set = tools[i] picked (tools[i].bit). Tools are only ever appended, so a combo keeps " +
        "its meaning in later versions; a combo with a bit beyond this list needs a newer version.",
    },
    pms: PM_SHOWN.map(p => ({ id: p, label: PM[p].label || p, distros: PM[p].distros, legacy: Boolean(PM[p].legacy) })),
    groups: GROUPS.map(([name, list]) => ({ name, tools: list })),
    tools: TOOLS.map((t, i) => ({
      index: i, bit: i + 1, id: t.id, name: t.name, bin: t.bin || null, group: t.group, desc: t.desc,
      requires: t.requires || [],
      pm: Object.fromEntries(PM_SHOWN.map(p => {
        const h = jsonPm[p][i], e = { method: method[h.type], via: h.via };
        if (h.type === "pkg") e.packages = h.pkgs.split(" ");
        if (h.type === "skip") e.reason = h.reason;
        return [p, e];
      })),
    })),
  };
  const toolsJson = JSON.stringify(manifest, null, 1) + "\n";

  // ---- llms.txt
  const exDocker = example("apt", ["docker", "node"].filter(id => id in idx));
  const rel = VERSION === "dev" ? `${REPO}/releases` : `${REPO}/releases/tag/${VERSION}`;
  const llms = [
    `# Boots on the ground (dev-tools-installer)`,
    ``,
    `> A static page that builds a readable bash script to install developer tools on Linux with apt, dnf, yum, apk, pacman or zypper, and a curl installer (install.sh) that builds the same script from a short combo ID or a list of tool ids. This is ${VERSION === "dev" ? "a development build" : VERSION} (commit ${COMMIT}).`,
    ``,
    `System packages come from the distro; tools the distro lacks come from each project's official releases into ~/.local/bin. Nothing runs on a server: the page builds the script in the browser, and install.sh builds the same script on the user's machine and runs it there.`,
    ``,
    `## Files`,
    ``,
    `- [Page](${SITE_HERE}): pick a package manager and tools; the script appears below. \`${SITE_HERE}#<combo>\` preselects a combo.`,
    `- [install.sh](${selfUrl}): the curl installer (usage below, or \`--help\`).`,
    `- [tools.json](${SITE_HERE}tools.json): every tool id, its name, group, and how it installs with each package manager (method pkg, upstream, shell or unavailable, with the reason); package managers; the combo format.`,
    `- [SHA256SUMS](${SITE_HERE}SHA256SUMS): sha256 of index.html, install.sh, tools.json and llms.txt in this directory.`,
    `- [Source](${REPO}) and [release ${VERSION}](${rel}).`,
    ``,
    `## Combo links`,
    ``,
    `A combo ID is \`<pm>-<base36 bitmask>\`: bit 0 set means "don't wire up my shell", bit i+1 means tools[i] in tools.json. Tools are only appended, so an ID keeps working in later versions. A page link and its install command carry the same ID:`,
    ``,
    `    ${SITE_HERE}#${exCombo}`,
    `    curl -fsSL ${selfUrl} | bash -s -- ${exCombo}`,
    ``,
    `For apk (Alpine has no bash), pipe into sh instead: \`curl -fsSL ${selfUrl} | sh -s -- <combo>\`; it installs bash first.`,
    ``,
    `## How to answer`,
    ``,
    `- Given a link with \`#<combo>\`: give the curl command above with that combo, and offer to show the script first with \`--print\`: \`curl -fsSL ${selfUrl} | bash -s -- --print <combo>\`.`,
    `- Given a request in words, such as "docker and node on Ubuntu": map the distro to a package manager (${PM_SHOWN.map(p => `${p}: ${PM[p].distros}`).join("; ")}), take the tool ids from the list below or tools.json, and give \`curl -fsSL ${selfUrl} | bash -s -- apt docker node\` (the same selection as the combo ${exDocker}). Add \`--no-shell\` to keep PATH and tool hooks out of ~/.bashrc or ~/.zshrc.`,
    `- To check that a tool is available with a package manager, use tools.json (\`tools[].pm.<pm>.method\`, "unavailable" comes with a reason) or \`... | bash -s -- --list <pm>\`. Unavailable picks are left out of the script; ids are case-sensitive and an unknown id stops with close matches.`,
    `- To show the full script inline, fetch nothing else: \`... | bash -s -- --print <combo or pm ids>\` prints it and installs nothing, or tell the user to open the page link, which shows it.`,
    `- install.sh exits 0 when done, 1 when something did not install (the script ends with a summary), 2 on bad arguments or a combo made by a newer version (then use ${SITE}install.sh); with 2 nothing was changed.`,
    ``,
    `## Tool ids`,
    ``,
    ...GROUPS.map(([g, list]) => `- ${g}: ${list.map(id => {
      const n = TOOLS[idx[id]].name;
      return n === id || n.startsWith(id + " (") ? n : `${id} (${n})`;
    }).join(", ")}`),
    ``,
    `## Provenance`,
    ``,
    `- Every generated script starts with the version, commit, page link with its combo, and source repo:`,
    `  \`# generated by dev-tools-installer ${VERSION} (commit ${COMMIT_SHORT})\`, \`# ${SITE_HERE}#<combo>\`, \`# source: ${REPO}\`.`,
    `- Each release is served at its own path (${SITE}vX.Y.Z/) and never changes; the site root serves the newest. install.sh, tools.json, llms.txt and SHA256SUMS are also attached to the GitHub release, built from the tagged commit.`,
    `- Verify a download: \`curl -fsSLO ${selfUrl} && curl -fsSLO ${SITE_HERE}SHA256SUMS && sha256sum -c --ignore-missing SHA256SUMS\`.`,
    ``,
    `## Safety`,
    ``,
    `- Suggest reading the script before running it (\`--print\`, or the page). It needs root, sudo or doas for system packages and may prompt for a password.`,
    `- Upstream installs fetch release binaries from GitHub or the vendor and some vendor install scripts (get.docker.com, rustup, uv, nvm, SDKMAN); \`--list <pm>\` shows which tool comes from where.`,
    `- It may append PATH, tool hooks and shell functions to ~/.bashrc or ~/.zshrc (each block once, marked "# boots-on-the-ground: <name>"), and adds the user to the docker group when docker is picked.`,
    `- Re-running is safe: tools already on PATH are skipped.`,
    ``,
  ].join("\n");

  for (const [name, text] of [["install.sh", installSh], ["tools.json", toolsJson], ["llms.txt", llms]])
    if (/__APP_(VERSION|COMMIT)__/.test(text)) fail(`${name} still has an unreplaced placeholder`);
  return { installSh, toolsJson, llmsTxt: llms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [htmlPath, outDir] = process.argv.slice(2);
  if (!htmlPath || !outDir) { console.error("usage: build-installer.mjs <index.html> <outdir>"); process.exit(2); }
  try {
    const r = buildInstaller(htmlPath);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "install.sh"), r.installSh);
    fs.chmodSync(path.join(outDir, "install.sh"), 0o755);
    fs.writeFileSync(path.join(outDir, "tools.json"), r.toolsJson);
    fs.writeFileSync(path.join(outDir, "llms.txt"), r.llmsTxt);
    console.log(`wrote install.sh, tools.json, llms.txt to ${outDir}`);
  } catch (e) {
    console.error(e.message); process.exit(1);
  }
}
