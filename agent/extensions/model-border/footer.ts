/**
 * Pi joins the stats with single spaces and separates the model with at least two.
 * Token totals are optional, so match their prefixes to keep the remaining metrics in place.
 */
export function statsOnly(line: string): string {
	const parts = line.split(/(\x1b\[[0-9;]*m)/); // text at even indexes, escape sequences at odd ones
	const firstText = parts[0] ? 0 : 2;
	if (firstText < parts.length) {
		parts[firstText] = parts[firstText]
			.replace(/^(?:[↑↓RW]\d+(?:\.\d+)?[kM]? )+/, "")
			.replace(/^CH(?=\d)/, "🖫");
	}
	for (let i = 0; i < parts.length; i += 2) {
		const cut = parts[i].indexOf("  ");
		if (cut >= 0) return `${parts.slice(0, i).join("")}${parts[i].slice(0, cut)}\x1b[39m`;
	}
	return parts.join("");
}
