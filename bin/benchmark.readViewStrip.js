const zlib = require("zlib");
const XMLSerializer = require("../lib/wt2html/XMLSerializer.js");
const { DOMTraverser } = require("../lib/utils/DOMTraverser.js");
const { DOMUtils } = require("../lib/utils/DOMUtils.js");
const { fetchHTML } = require("./diff.html.js");

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

function diffSize(res, rules) {
	const body = DOMUtils.parseHTML(res).body;
	const deflatedOriginalSize = zlib.deflateSync(
        XMLSerializer.serialize(body).html
	).byteLength;

	const stripped = stripReadView(body, rules);
	const deflatedStrippedSize = zlib.deflateSync(
        XMLSerializer.serialize(stripped).html
	).byteLength;

	return {
		originalSize: deflatedOriginalSize,
		strippedSize: deflatedStrippedSize,
	};
}

function benchmarkReadView(endpoint, proxy, domain, title, rules) {
	return fetchHTML(endpoint, proxy, domain, title).then((res) => {
		return diffSize(res, rules);
	});
}

module.exports.benchmarkReadView = benchmarkReadView;
