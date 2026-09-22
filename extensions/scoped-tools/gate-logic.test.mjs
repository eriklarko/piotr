// Regression test for the pure validation logic in utils.ts.
// Imports the real implementation -- no copies to drift.
// Run: node --experimental-strip-types gate-logic.test.mjs

import {
	buildDiffArgv,
	isBlockedMakeVar,
	isGatedWritePath,
	isSafeRef,
	isSafeToken,
	resolveDeletePath,
	validVar,
} from "./utils.ts";

let fail = 0;
function eq(name, got, want) { const ok = got === want; if (!ok) { fail++; console.log("FAIL", name, "got", got, "want", want); } else console.log("ok  ", name); }

// isSafeToken — general flag/whitespace rejection
eq("origin safe", isSafeToken("origin"), true);
eq("feature/x safe", isSafeToken("feature/x"), true);
eq("flag unsafe", isSafeToken("--force"), false);
eq("dash unsafe", isSafeToken("-x"), false);
eq("space unsafe", isSafeToken("a b"), false);
eq("empty unsafe", isSafeToken(""), false);

// isSafeRef — git_push remote/branch validation. Adds refspec syntax on top
// of isSafeToken: '+' forces, ':' can push/delete a different ref than named.
eq("origin safe ref", isSafeRef("origin"), true);
eq("feature/x safe ref", isSafeRef("feature/x"), true);
eq("force-push refspec blocked", isSafeRef("+HEAD:main"), false);
eq("cross-branch refspec blocked", isSafeRef("HEAD:main"), false);
eq("delete refspec blocked", isSafeRef(":main"), false);
eq("bare plus blocked", isSafeRef("+main"), false);
eq("still rejects flags", isSafeRef("--force"), false);

// make var validation
eq("VAR=1 ok", validVar("CC=gcc"), true);
eq("VAR= empty ok", validVar("X="), true);
eq("--eval blocked", validVar("--eval=$(shell x)"), false);
eq("leading digit blocked", validVar("1X=y"), false);
eq("no equals blocked", validVar("target"), false);

// isBlockedMakeVar — MAKEFILES/MAKEFLAGS/GNUMAKEFLAGS can redirect which
// Makefile is read or inject make's own flags; blocked even though they are
// syntactically valid VAR=value assignments.
eq("MAKEFILES blocked", isBlockedMakeVar("MAKEFILES=/tmp/evil.mk"), true);
eq("MAKEFLAGS blocked", isBlockedMakeVar("MAKEFLAGS=--eval=x"), true);
eq("GNUMAKEFLAGS blocked", isBlockedMakeVar("GNUMAKEFLAGS=-x"), true);
eq("CC not blocked", isBlockedMakeVar("CC=gcc"), false);

// isGatedWritePath — edit/write to these paths needs the same confirmation
// as git_commit/git_push, since they are shell-equivalent in build mode.
eq("Makefile gated", isGatedWritePath("Makefile"), true);
eq("makefile gated", isGatedWritePath("makefile"), true);
eq("GNUmakefile gated", isGatedWritePath("GNUmakefile"), true);
eq("Makefile in subdirectory gated", isGatedWritePath("docker-sandbox/Makefile"), true);
eq("*.mk gated", isGatedWritePath("build.mk"), true);
eq("*.mk in subdirectory gated", isGatedWritePath("scripts/build.mk"), true);
eq("Makefile.md not gated", isGatedWritePath("Makefile.md"), false);
eq("git hooks path gated", isGatedWritePath(".git/hooks/pre-commit"), true);
eq("nested git hooks path gated", isGatedWritePath("sub/.git/hooks/pre-commit"), true);
eq("ordinary source file not gated", isGatedWritePath("extensions/scoped-tools/index.ts"), false);
eq("README not gated", isGatedWritePath("README.md"), false);

// resolveDeletePath — delete targets are confined to the project and never
// inside .git. Purely lexical; the tool does the stat/directory checks.
const CWD = "/repo";
eq("relative path resolves", resolveDeletePath(CWD, "src/x.ts").relPath, "src/x.ts");
eq("absolute path inside cwd resolves", resolveDeletePath(CWD, "/repo/src/x.ts").relPath, "src/x.ts");
eq("absolute path inside cwd has no error", resolveDeletePath(CWD, "/repo/src/x.ts").error, undefined);
eq("parent escape errors", !!resolveDeletePath(CWD, "../outside.ts").error, true);
eq("absolute path outside cwd errors", !!resolveDeletePath(CWD, "/etc/passwd").error, true);
eq("empty path errors", !!resolveDeletePath(CWD, "").error, true);
eq("project root errors", !!resolveDeletePath(CWD, ".").error, true);
eq("git config errors", !!resolveDeletePath(CWD, ".git/config").error, true);
eq("git hook errors", !!resolveDeletePath(CWD, ".git/hooks/pre-commit").error, true);
eq("nested git dir errors", !!resolveDeletePath(CWD, "sub/.git/index").error, true);
eq(".gitignore allowed", resolveDeletePath(CWD, ".gitignore").relPath, ".gitignore");

// git_diff — base/head ref comparison
eq("base only errors", !!buildDiffArgv({ base: "origin/master" }).error, true);
eq("head only errors", !!buildDiffArgv({ head: "HEAD" }).error, true);
eq("base+head argv", JSON.stringify(buildDiffArgv({ base: "origin/master", head: "HEAD" }).argv), JSON.stringify(["diff", "origin/master..HEAD"]));
eq("base+head+staged errors", !!buildDiffArgv({ base: "origin/master", head: "HEAD", staged: true }).error, true);
eq("base+head+paths argv", JSON.stringify(buildDiffArgv({ base: "a", head: "b", paths: ["src/x.ts"] }).argv), JSON.stringify(["diff", "a..b", "--", "src/x.ts"]));
eq("unsafe base errors", !!buildDiffArgv({ base: "--force", head: "HEAD" }).error, true);
eq("no refs, no staged", JSON.stringify(buildDiffArgv({}).argv), JSON.stringify(["diff"]));
eq("no refs, staged", JSON.stringify(buildDiffArgv({ staged: true }).argv), JSON.stringify(["diff", "--staged"]));

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
