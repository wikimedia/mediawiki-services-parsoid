const zlib = require("zlib");
const XMLSerializer = require("../lib/wt2html/XMLSerializer.js");
const { DOMTraverser } = require("../lib/utils/DOMTraverser.js");
const { DOMUtils } = require("../lib/utils/DOMUtils.js");
const { ScriptUtils } = require('../tools/ScriptUtils.js');


function stripReadView(root, rules, ruleNames) {
	const traverser = new DOMTraverser();

	traverser.addHandler(null, (node) => {

		function matcher(rule, value) {
			if (rule && rule.regex) {
				const regex = new RegExp(rule.regex);
				return regex.test(value);
			}
			return true;
		}

		ruleNames.forEach(ruleName => {
			const rule = rules[ruleName];
			const value =
				DOMUtils.isElt(node) &&
				node.hasAttribute(rule.attribute) &&
				node.getAttribute(rule.attribute);
			if (value && matcher(rule.attribute, rule.value)) {
				node.removeAttribute(rule.attribute);
			}
		});

		return true;
	});

	traverser.traverse(root);
	return root;
}

function mwAPIParserOutput(domain, title) {
	const mwAPIUrl = `https://${domain}/w/api.php?action=parse&page=${encodeURIComponent(title)}&format=json&disablelimitreport=true`;
	const httpOptions = {
		method: 'GET',
		headers: {
			'User-Agent': 'Parsoid-Test'
		},
		uri: mwAPIUrl,
		json: true
	};
	return ScriptUtils.retryingHTTPRequest(2, httpOptions);
}

function strippedSize(body, rules, ruleNames) {
	const stripped = stripReadView(body, rules, ruleNames);
	return zlib.gzipSync(
		XMLSerializer.serialize(stripped).html
	).byteLength;
}

async function benchmarkReadView(domain, title, parsoidHTML, rules) {
	const mwParserOutputBody = await mwAPIParserOutput(domain, title);
	const mwParserSize = zlib.gzipSync(mwParserOutputBody[1].parse.text['*']).byteLength;

	const body = DOMUtils.parseHTML(parsoidHTML).body;
	const deflatedOriginalSize = zlib.gzipSync(
		XMLSerializer.serialize(body).html
	).byteLength;

	const results = {
		mwParser: mwParserSize,
		original: deflatedOriginalSize
	};

	// Metrics per stripped attribute
	Object.keys(rules).forEach(ruleName => {
		results[ruleName] = strippedSize(body, rules, [ruleName]);
	});

	// Metrics for all stripped attributes
	results.stripped = strippedSize(body, rules, Object.keys(rules));

	return results;
}

module.exports.benchmarkReadView = benchmarkReadView;
