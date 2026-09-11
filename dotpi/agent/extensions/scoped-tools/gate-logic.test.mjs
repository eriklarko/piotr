// Regression test for the pure validation logic in index.ts.
// These functions have no pi dependency, so we mirror them here and assert
// behavior. If you change the originals in index.ts, update these copies.
// Run: node gate-logic.test.mjs

// --- copies of the pure logic under test (kept in sync with index.ts) ---
function isSafeToken(token) {
  return token.length > 0 && !token.startsWith("-") && !/\s/.test(token);
}
function validVar(v){ return /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(v); }

// git_diff argv construction (mirrors execute() in index.ts)
function buildDiffArgv(params) {
  const hasBase = params.base != null;
  const hasHead = params.head != null;
  if (hasBase !== hasHead) return { error: "base and head must be given together" };
  if (hasBase && hasHead && params.staged) return { error: "staged cannot be combined with base/head" };

  const argv = ["diff"];
  if (hasBase && hasHead) {
    if (!isSafeToken(params.base)) return { error: `invalid base ref: ${params.base}` };
    if (!isSafeToken(params.head)) return { error: `invalid head ref: ${params.head}` };
    argv.push(`${params.base}..${params.head}`);
  } else if (params.staged) {
    argv.push("--staged");
  }
  if (params.paths?.length) {
    for (const p of params.paths) {
      if (p.startsWith("-")) return { error: `path may not start with "-": ${p}` };
    }
    argv.push("--", ...params.paths);
  }
  return { argv };
}

let fail = 0;
function eq(name, got, want){ const ok = got===want; if(!ok){fail++; console.log("FAIL",name,"got",got,"want",want);} else console.log("ok  ",name); }

// isSafeToken — git_push remote/branch validation
eq("origin safe", isSafeToken("origin"), true);
eq("feature/x safe", isSafeToken("feature/x"), true);
eq("flag unsafe", isSafeToken("--force"), false);
eq("dash unsafe", isSafeToken("-x"), false);
eq("space unsafe", isSafeToken("a b"), false);
eq("empty unsafe", isSafeToken(""), false);

// make var validation
eq("VAR=1 ok", validVar("CC=gcc"), true);
eq("VAR= empty ok", validVar("X="), true);
eq("--eval blocked", validVar("--eval=$(shell x)"), false);
eq("leading digit blocked", validVar("1X=y"), false);
eq("no equals blocked", validVar("target"), false);

// git_diff — base/head ref comparison
eq("base only errors", !!buildDiffArgv({ base: "origin/master" }).error, true);
eq("head only errors", !!buildDiffArgv({ head: "HEAD" }).error, true);
eq("base+head argv", JSON.stringify(buildDiffArgv({ base: "origin/master", head: "HEAD" }).argv), JSON.stringify(["diff", "origin/master..HEAD"]));
eq("base+head+staged errors", !!buildDiffArgv({ base: "origin/master", head: "HEAD", staged: true }).error, true);
eq("base+head+paths argv", JSON.stringify(buildDiffArgv({ base: "a", head: "b", paths: ["src/x.ts"] }).argv), JSON.stringify(["diff", "a..b", "--", "src/x.ts"]));
eq("unsafe base errors", !!buildDiffArgv({ base: "--force", head: "HEAD" }).error, true);
eq("no refs, no staged", JSON.stringify(buildDiffArgv({}).argv), JSON.stringify(["diff"]));
eq("no refs, staged", JSON.stringify(buildDiffArgv({ staged: true }).argv), JSON.stringify(["diff", "--staged"]));

console.log(fail? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail?1:0);
