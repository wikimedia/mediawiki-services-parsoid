#!/usr/bin/env node

/*
 * This could have been done via wget with this url:
 *
 * http://<PREFIX>.wikipedia.org/w/api.php?format=txt&action=query&prop=revisions&rvprop=content&revids=<OLDID>
 *
 * and then use sed to extract the wikitext out of the result
 *
 * But I had to do it the hard way mostly because this has independent utility
 */

var api = require('../lib/mediawiki.ApiRequest.js'),
	ParsoidConfig = require( '../lib/mediawiki.ParsoidConfig.js' ).ParsoidConfig,
	ParserEnv = require('../lib/mediawiki.parser.environment.js').MWParserEnvironment;

var argv = process.argv.slice(process.argv[0] === 'node' ? 2 : 1);
if (argv.length === 0) {
	console.warn("Usage: [node] fetch-wt.js <rev-id> [<opt-wiki-prefix>]");
	return;
}

var revid = argv[0];
var prefix = argv.length > 0 ? argv[1] : "en";
var parsoidConfig = new ParsoidConfig( null, { defaultWiki: prefix } );

ParserEnv.getParserEnv( parsoidConfig, null, prefix, null, function ( err, env ) {
	var req = new api.TemplateRequest(env, null, revid);
	req.listeners('src').push(function(err, page) {
		console.log(page.revision['*']);
	});
});
