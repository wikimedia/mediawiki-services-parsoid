const zlib = require("zlib");
const XMLSerializer = require("../lib/wt2html/XMLSerializer.js");
const { DOMTraverser } = require("../lib/utils/DOMTraverser.js");
const { DOMUtils } = require("../lib/utils/DOMUtils.js");

function stripReadView(root, rules) {
	const traverser = new DOMTraverser();

	traverser.addHandler(null, (node) => {

		function matcher(rule, value) {
			if (rule && rule.regex) {
				const regex = new RegExp(rule.regex);
				return regex.test(value);
			}
			return true;
		}

		Object.entries(rules).forEach(([attribute, rule]) => {
			const value =
                DOMUtils.isElt(node) &&
                node.hasAttribute(attribute) &&
                node.getAttribute(attribute);

			if (value && matcher(rule, value)) {
				node.removeAttribute(attribute);
			}
		});

		return true;
	});

	traverser.traverse(root);
	return root;
}

function diffSize(html, rules) {
	const body = DOMUtils.parseHTML(html).body;
	const deflatedOriginalSize = zlib.gzipSync(
        XMLSerializer.serialize(body).html
	).byteLength;

	const stripped = stripReadView(body, rules);
	const deflatedStrippedSize = zlib.gzipSync(
        XMLSerializer.serialize(stripped).html
	).byteLength;

	return {
		originalSize: deflatedOriginalSize,
		strippedSize: deflatedStrippedSize,
	};
}

function benchmarkReadView(domain, title, parsoidHTML, rules) {
	// We may later fetch core parser HTML here based on domain & title
	return diffSize(parsoidHTML, rules);
}

module.exports.benchmarkReadView = benchmarkReadView;
