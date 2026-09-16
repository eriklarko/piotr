import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ANGER_CUE = "hey, I see you're getting angry";

const MINIMUM_LETTERS = 12;
const UPPERCASE_RATIO = 0.65;

export function shouldShowAngerCue(text: string): boolean {
	if (/\bcunt\b/i.test(text)) return true;
	if ((text.match(/\bfuck\b/gi)?.length ?? 0) >= 2) return true;

	const letters = text.match(/[a-z]/gi) ?? [];
	if (letters.length < MINIMUM_LETTERS) return false;

	const uppercaseLetters = letters.filter((letter) => /[A-Z]/.test(letter)).length;
	return uppercaseLetters / letters.length >= UPPERCASE_RATIO;
}

export default function angerCueExtension(pi: ExtensionAPI): void {
	pi.on("input", (event, ctx) => {
		if (event.source !== "extension" && shouldShowAngerCue(event.text)) {
			ctx.ui.notify(ANGER_CUE, "info");
		}

		return { action: "continue" };
	});
}
