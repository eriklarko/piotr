import { relative, resolve } from "node:path";

/**
 * Pure validation logic for scoped-tools, kept separate from index.ts so
 * gate-logic.test.mjs can import the real implementation instead of keeping
 * copies that can silently drift (the pattern mode-controller/utils.ts
 * already uses).
 */

/** Reject a token that looks like a flag or tries to smuggle extra args. */
export function isSafeToken(token: string): boolean {
	return token.length > 0 && !token.startsWith("-") && !/\s/.test(token);
}

/**
 * Reject anything isSafeToken rejects, plus git's refspec syntax: '+' forces
 * a push (bypassing "no force push"), and ':' can push to/delete a branch
 * other than the one named (src:dst, or a bare ':dst' delete). git_push's
 * remote/branch params are meant to be plain names, not refspecs.
 */
export function isSafeRef(token: string): boolean {
	return isSafeToken(token) && !token.includes("+") && !token.includes(":");
}

/** `make` VAR=value assignment: a valid shell identifier, then anything. */
export function validVar(v: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(v);
}

/**
 * `make` variable names that override which Makefile(s) get read
 * (MAKEFILES) or how make itself behaves (MAKEFLAGS/GNUMAKEFLAGS, which can
 * inject arbitrary flags like `--eval`). Rejected outright rather than
 * validated as a normal VAR=value, since a syntactically valid assignment
 * here is exactly the attack.
 */
const BLOCKED_MAKE_VAR_NAMES = new Set(["MAKEFILES", "MAKEFLAGS", "GNUMAKEFLAGS"]);

export function isBlockedMakeVar(v: string): boolean {
	const name = v.slice(0, v.indexOf("="));
	return BLOCKED_MAKE_VAR_NAMES.has(name);
}

export interface DiffParams {
	base?: string;
	head?: string;
	staged?: boolean;
	paths?: string[];
}

export interface DiffResult {
	argv?: string[];
	error?: string;
}

/** git_diff argv construction (mirrors execute() in index.ts). */
export function buildDiffArgv(params: DiffParams): DiffResult {
	const hasBase = params.base != null;
	const hasHead = params.head != null;
	if (hasBase !== hasHead) return { error: "base and head must be given together" };
	if (hasBase && hasHead && params.staged) return { error: "staged cannot be combined with base/head" };

	const argv = ["diff"];
	if (hasBase && hasHead) {
		if (!isSafeToken(params.base!)) return { error: `invalid base ref: ${params.base}` };
		if (!isSafeToken(params.head!)) return { error: `invalid head ref: ${params.head}` };
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

/**
 * Paths whose content make treats as its own recipe/rules, i.e. is a shell —
 * editing one is functionally the same privilege as editing a script that
 * `make` will later execute. Matches a Makefile at any depth (`Makefile`,
 * `makefile`, `GNUmakefile`, or `*.mk`), and separately `.git/hooks/**`,
 * which git executes directly on its own triggers (also reachable via
 * git_commit/git_push without an explicit `make` call).
 */
export interface DeletePathResult {
	relPath?: string;
	error?: string;
}

/**
 * Turn a model-supplied delete target into a project-relative path, or explain
 * the refusal. Purely lexical: existence and directory checks belong to the
 * tool itself. Refuses the project root, anything outside cwd, and anything
 * inside a `.git` directory — deleting there corrupts the repository and can
 * remove the very hooks/config that the write gate protects.
 */
export function resolveDeletePath(cwd: string, rawPath: string): DeletePathResult {
	if (rawPath.trim() === "") return { error: "path must not be empty" };

	const relPath = relative(cwd, resolve(cwd, rawPath)).replace(/\\/g, "/");
	if (relPath === "") return { error: "refusing to delete the project root" };
	if (relPath === ".." || relPath.startsWith("../")) {
		return { error: `path is outside the project directory: ${rawPath}` };
	}
	if (relPath.split("/").includes(".git")) {
		return { error: `refusing to delete inside .git: ${relPath}` };
	}
	return { relPath };
}

export function isGatedWritePath(relPath: string): boolean {
	const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
	const base = normalized.split("/").pop() ?? normalized;
	if (base === "Makefile" || base === "makefile" || base === "GNUmakefile") return true;
	if (/\.mk$/.test(base)) return true;
	if (/(^|\/)\.git\/hooks\//.test(normalized)) return true;
	return false;
}
