/**
 * Scoped Tools Extension
 *
 * Registers narrow, structured tools for git and make. It only REGISTERS tools;
 * which tools are active per mode is enumerated in the mode/kit config, not here.
 * bash is simply omitted from those modes that should not have it.
 *
 * Tools:
 *  - git_status, git_log, git_diff   (read-only)
 *  - git_add, git_commit, git_push   (mutating)
 *  - delete                          (removes a single file)
 *  - make                            (runs a target's Makefile recipe)
 *
 * Design principles (see scoped-tools.md in ~/.pi/plans):
 *  - No shell. Every tool builds a fixed argv and calls pi.exec(binary, argv).
 *    The model fills typed parameter fields; it never supplies raw flag strings.
 *  - No `args: string[]` passthrough. git is a shell delivery mechanism
 *    (core.pager, core.sshCommand, diff.external, aliases, hooks...), so a raw
 *    args array would make the tool boundary meaningless. Each subcommand is its
 *    own tool with typed params.
 *  - Friction is a feature. Complex git invocations are a smell (an agent losing
 *    the plot). Only the 90% path is modeled; add flags when a human hits a wall.
 *
 * git_commit and git_push prompt for confirmation, since they publish or
 * rewrite history. So does delete, which is unrecoverable for unstaged
 * content. So does edit/write on a Makefile-like path or a git hook
 * (Makefile, makefile, GNUmakefile, *.mk, .git/hooks/**) — `make` runs a
 * recipe's shell, and git executes a hook directly, so writing one of these
 * files is functionally the same privilege as commit/push in a mode that
 * doesn't otherwise have a shell. Everything else runs freely — the agent is
 * trusted to use the tools it is given. The confirm FAILS OPEN: with no UI
 * (print/JSON mode) there is no one to ask, so the action proceeds
 * unconfirmed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstat, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { Type } from "typebox";
import {
	isBlockedMakeVar,
	isGatedWritePath,
	isSafeRef,
	isSafeToken,
	resolveDeletePath,
	validVar,
} from "./utils.ts";

const EXEC_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 60_000;

// Tool names that require per-call confirmation. commit and push publish or
// rewrite history; delete destroys unstaged content unrecoverably. Everything
// else runs freely.
const CONFIRM_TOOLS = new Set(["git_commit", "git_push", "delete"]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_BYTES) return text;
	return `${text.slice(0, MAX_OUTPUT_BYTES)}\n\n[... output truncated at ${MAX_OUTPUT_BYTES} bytes ...]`;
}

interface RunResult {
	content: { type: "text"; text: string }[];
	details: { code: number; killed: boolean };
	isError?: boolean;
}

/** Run a fixed binary with a fixed argv. No shell involved. */
async function run(
	pi: ExtensionAPI,
	binary: string,
	argv: string[],
	signal: AbortSignal | undefined,
	cwd?: string,
): Promise<RunResult> {
	try {
		const result = await pi.exec(binary, argv, {
			signal,
			timeout: EXEC_TIMEOUT_MS,
			cwd,
		});
		const body = [result.stdout, result.stderr].filter(Boolean).join("\n");
		const text = truncate(body.trim() || `(${binary} exited ${result.code} with no output)`);
		return {
			content: [{ type: "text", text }],
			details: { code: result.code, killed: result.killed },
			isError: result.code !== 0,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text", text: `Failed to run ${binary}: ${message}` }],
			details: { code: -1, killed: false },
			isError: true,
		};
	}
}

/** A parameter/validation error surfaced to the model as an error result. */
function paramError(message: string): RunResult {
	return {
		content: [{ type: "text", text: `Invalid arguments: ${message}` }],
		details: { code: -1, killed: false },
		isError: true,
	};
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function scopedToolsExtension(pi: ExtensionAPI) {
	// This extension only REGISTERS tools. Which tools are active per mode is
	// enumerated in the mode/kit config, not forced here. bash is omitted there.

	// -- read-only git tools -----------------------------------------------

	pi.registerTool({
		name: "git_status",
		label: "git status",
		description: "Show the working tree status (git status).",
		promptSnippet: "Show git working tree status",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			return run(pi, "git", ["status"], signal);
		},
	});

	pi.registerTool({
		name: "git_log",
		label: "git log",
		description: "Show commit history (git log).",
		promptSnippet: "Show git commit history",
		parameters: Type.Object({
			maxCount: Type.Optional(Type.Integer({ minimum: 1, description: "Limit to the last N commits" })),
			oneline: Type.Optional(Type.Boolean({ description: "Compact one-line-per-commit format" })),
			paths: Type.Optional(
				Type.Array(Type.String(), { description: "Limit history to these paths" }),
			),
		}),
		async execute(_id, params, signal) {
			const argv = ["log"];
			if (params.maxCount != null) argv.push("-n", String(params.maxCount));
			if (params.oneline) argv.push("--oneline");
			if (params.paths?.length) {
				for (const p of params.paths) {
					if (p.startsWith("-")) return paramError(`path may not start with "-": ${p}`);
				}
				argv.push("--", ...params.paths);
			}
			return run(pi, "git", argv, signal);
		},
	});

	pi.registerTool({
		name: "git_diff",
		label: "git diff",
		description:
			"Show changes (git diff). By default shows unstaged (or staged) changes " +
			"in the working tree. Pass base and head together to diff any two refs " +
			"instead (e.g. base=origin/master, head=HEAD for a PR-style diff).",
		promptSnippet: "Show git diff of working tree, staged changes, or two refs",
		parameters: Type.Object({
			staged: Type.Optional(Type.Boolean({ description: "Show staged changes (--staged) instead of unstaged" })),
			base: Type.Optional(
				Type.String({ description: "Base ref to diff from. Must be given together with head, e.g. origin/master." }),
			),
			head: Type.Optional(
				Type.String({ description: "Head ref to diff to. Must be given together with base, e.g. HEAD." }),
			),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Limit diff to these paths" })),
		}),
		async execute(_id, params, signal) {
			const hasBase = params.base != null;
			const hasHead = params.head != null;
			if (hasBase !== hasHead) return paramError("base and head must be given together");
			if (hasBase && hasHead && params.staged) {
				return paramError("staged cannot be combined with base/head");
			}

			const argv = ["diff"];
			if (hasBase && hasHead) {
				if (!isSafeToken(params.base!)) return paramError(`invalid base ref: ${params.base}`);
				if (!isSafeToken(params.head!)) return paramError(`invalid head ref: ${params.head}`);
				argv.push(`${params.base}..${params.head}`);
			} else if (params.staged) {
				argv.push("--staged");
			}
			if (params.paths?.length) {
				for (const p of params.paths) {
					if (p.startsWith("-")) return paramError(`path may not start with "-": ${p}`);
				}
				argv.push("--", ...params.paths);
			}
			return run(pi, "git", argv, signal);
		},
	});

	// -- mutating git tools (per-call approval via tool_call gate) ---------

	pi.registerTool({
		name: "git_add",
		label: "git add",
		description: "Stage specific files for commit (git add). Explicit paths only; no -A/. shorthand.",
		promptSnippet: "Stage specific files with git add (explicit paths)",
		promptGuidelines: [
			"Use git_add with explicit file paths. There is no way to stage everything at once; list the files you mean.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { minItems: 1, description: "Exact file paths to stage" }),
		}),
		async execute(_id, params, signal) {
			for (const p of params.paths) {
				if (p.startsWith("-")) return paramError(`path may not start with "-": ${p}`);
			}
			return run(pi, "git", ["add", "--", ...params.paths], signal);
		},
	});

	pi.registerTool({
		name: "git_commit",
		label: "git commit",
		description: "Create a commit from staged changes (git commit -m).",
		promptSnippet: "Commit staged changes with a message",
		parameters: Type.Object({
			message: Type.String({ minLength: 1, description: "Commit message" }),
			amend: Type.Optional(Type.Boolean({ description: "Amend the previous commit" })),
		}),
		async execute(_id, params, signal) {
			const argv = ["commit", "-m", params.message];
			if (params.amend) argv.push("--amend");
			return run(pi, "git", argv, signal);
		},
	});

	pi.registerTool({
		name: "git_push",
		label: "git push",
		description: "Push commits to a remote (git push). No force push, branch deletion, or cross-branch refspecs.",
		promptSnippet: "Push commits to a remote branch",
		parameters: Type.Object({
			remote: Type.Optional(Type.String({ description: "Remote name (e.g. origin)" })),
			branch: Type.Optional(Type.String({ description: "Branch name to push" })),
		}),
		async execute(_id, params, signal) {
			const argv = ["push"];
			if (params.remote != null) {
				if (!isSafeRef(params.remote)) return paramError(`invalid remote: ${params.remote}`);
				argv.push(params.remote);
			}
			if (params.branch != null) {
				// isSafeRef, not isSafeToken: '+'/':' are git's refspec syntax
				// (force, delete, or push-to-a-different-branch) and 'branch' is
				// meant to be a plain name, not a refspec.
				if (!isSafeRef(params.branch)) return paramError(`invalid branch: ${params.branch}`);
				argv.push(params.branch);
			}
			return run(pi, "git", argv, signal);
		},
	});

	// -- make (always requires approval; runs arbitrary shell from Makefile)

	pi.registerTool({
		name: "make",
		label: "make",
		description: "Run a make target. Trusted Makefile only; runs the recipe's shell.",
		promptSnippet: "Run a make target",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: "Make target (default target if omitted)" })),
			vars: Type.Optional(
				Type.Array(Type.String(), { description: "VAR=value assignments" }),
			),
			directory: Type.Optional(Type.String({ description: "Run make in this directory (-C)" })),
		}),
		async execute(_id, params, signal) {
			const argv: string[] = [];
			if (params.directory != null) {
				if (params.directory.startsWith("-")) return paramError(`directory may not start with "-"`);
				argv.push("-C", params.directory);
			}
			if (params.vars?.length) {
				for (const v of params.vars) {
					if (!validVar(v)) {
						return paramError(`variable must be VAR=value: ${v}`);
					}
					if (isBlockedMakeVar(v)) {
						return paramError(
							`variable not allowed: ${v} (MAKEFILES/MAKEFLAGS/GNUMAKEFLAGS can redirect which Makefile make reads or inject its own flags)`,
						);
					}
				}
				argv.push(...params.vars);
			}
			if (params.target != null) {
				if (params.target.startsWith("-") || /\s/.test(params.target)) {
					return paramError(`invalid target: ${params.target}`);
				}
				argv.push(params.target);
			}
			return run(pi, "make", argv, signal);
		},
	});

	// -- delete (single file; confirmed, since it is unrecoverable) ---------

	pi.registerTool({
		name: "delete",
		label: "delete",
		description:
			"Delete a single file. One file per call: no directories, no globs, " +
			"nothing outside the project directory, nothing inside .git.",
		promptSnippet: "Delete a single file",
		parameters: Type.Object({
			path: Type.String({ minLength: 1, description: "Path of the file to delete" }),
		}),
		async execute(_id, params) {
			const cwd = process.cwd();
			const { relPath, error } = resolveDeletePath(cwd, params.path);
			if (error != null) return paramError(error);

			const target = resolve(cwd, params.path);
			try {
				// lstat, not stat: a symlink is deleted as a link, never followed.
				const stats = await lstat(target);
				if (stats.isDirectory()) {
					return paramError(`${relPath} is a directory; delete handles one file at a time`);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Cannot delete ${relPath}: ${message}` }],
					details: { code: -1, killed: false },
					isError: true,
				};
			}

			try {
				await rm(target);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Failed to delete ${relPath}: ${message}` }],
					details: { code: -1, killed: false },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Deleted ${relPath}` }],
				details: { code: 0, killed: false },
			};
		},
	});

	// -- confirmation on commit, push, and Makefile-like/hook writes -------
	//
	// Confirm git_commit and git_push, since they publish or rewrite history,
	// and delete, which cannot be undone for unstaged content.
	// Also confirm edit/write when the target is a Makefile-like path or a git
	// hook: those are read by `make`/git as a shell, so writing one is the same
	// privilege as commit/push in a mode without `bash`. Everything else
	// (including make and bash itself, wherever a mode enables them) runs
	// freely — the agent is trusted to use the tools it is given. With no UI
	// (print/json mode) confirmation is skipped and the action proceeds (fail
	// open), same as commit/push.

	pi.on("tool_call", async (event, ctx) => {
		let detail: string | undefined;

		if (CONFIRM_TOOLS.has(event.toolName)) {
			detail = describeMutation(event.toolName, event.input);
		} else if (event.toolName === "edit" || event.toolName === "write") {
			const rawPath = (event.input as { path?: unknown }).path;
			if (typeof rawPath === "string") {
				const relPath = relative(ctx.cwd, resolve(ctx.cwd, rawPath));
				if (isGatedWritePath(relPath)) {
					detail = `${event.toolName === "write" ? "Write" : "Edit"} ${relPath} — make/git treat this as a shell, so this needs the same confirmation as a commit or push.`;
				}
			}
		}

		if (detail == null) return undefined;
		if (!ctx.hasUI) return undefined; // fail open: no one to ask

		const ok = await ctx.ui.confirm(`Allow ${event.toolName}?`, detail);
		if (!ok) return { block: true, reason: "Blocked by user" };

		return undefined;
	});
}

/** Human-readable summary of what a mutating call will do, for the confirm prompt. */
function describeMutation(toolName: string, input: unknown): string {
	const i = input as Record<string, unknown>;
	switch (toolName) {
		case "git_commit":
			return `Commit${i.amend ? " (amend)" : ""}: ${String(i.message ?? "")}`;
		case "git_push":
			return `Push to ${String(i.remote ?? "default remote")} ${String(i.branch ?? "")}`.trim();
		case "delete":
			return `Delete ${String(i.path ?? "")}`;
		default:
			return "This action modifies repository state.";
	}
}
