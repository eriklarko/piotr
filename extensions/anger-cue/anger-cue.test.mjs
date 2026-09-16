import angerCueExtension, { ANGER_CUE, shouldShowAngerCue } from "./index.ts";

let failures = 0;

function equal(name, actual, expected) {
	const passed = actual === expected;
	if (passed) {
		console.log("ok  ", name);
		return;
	}

	failures++;
	console.log("FAIL", name, "got", JSON.stringify(actual), "want", JSON.stringify(expected));
}

// Pattern detection.
equal("standalone cunt triggers", shouldShowAngerCue("you CUNT"), true);
equal("cunt inside another word does not trigger", shouldShowAngerCue("Scunthorpe"), false);
equal("two fuck occurrences trigger", shouldShowAngerCue("fuck this, FUCK that"), true);
equal("one fuck occurrence does not trigger", shouldShowAngerCue("what the fuck"), false);
equal("no fuck occurrences do not trigger", shouldShowAngerCue("please try again"), false);
equal("caps threshold triggers", shouldShowAngerCue("ABCDEFGHijkl!!!"), true);
equal("short caps do not trigger", shouldShowAngerCue("ABCDEFGHIJK!!!"), false);
equal("caps below ratio do not trigger", shouldShowAngerCue("ABCDEFGhijkl!!!"), false);

// Input-event integration.
let inputHandler;
angerCueExtension({
	on(eventName, handler) {
		if (eventName === "input") inputHandler = handler;
	},
});

equal("registers an input handler", typeof inputHandler, "function");

async function runInput(text, source) {
	const notifications = [];
	const event = { text, source };
	const result = await inputHandler(event, {
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});
	return { event, notifications, result };
}

const interactive = await runInput("CUNT", "interactive");
equal("interactive match emits cue once", interactive.notifications.length, 1);
equal("interactive cue text is exact", interactive.notifications[0]?.message, ANGER_CUE);
equal("interactive match continues", interactive.result?.action, "continue");
equal("interactive input is unchanged", interactive.event.text, "CUNT");

const rpc = await runInput("FUCK this FUCK that", "rpc");
equal("RPC match emits cue once", rpc.notifications.length, 1);
equal("RPC match continues", rpc.result?.action, "continue");

const nonmatch = await runInput("please try again", "interactive");
equal("nonmatch emits no cue", nonmatch.notifications.length, 0);
equal("nonmatch continues", nonmatch.result?.action, "continue");

const injected = await runInput("CUNT", "extension");
equal("extension-injected match emits no cue", injected.notifications.length, 0);
equal("extension-injected match continues", injected.result?.action, "continue");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
