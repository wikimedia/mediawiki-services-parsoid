var domino = require('domino');

// No instance properties
function Parsoid() {}

function initParsoid() {
	var path = require('path');
	var fileDependencies = [];
	var basePath = '..';

	function _require(filename) {
		var fullpath = path.join( basePath, filename );
		fileDependencies.push( fullpath );
		return require( fullpath );
	}

	function _import(filename, symbols) {
		var module = _require(filename);
		symbols.forEach(function(symbol) {
			global[symbol] = module[symbol];
		});
	}

	_import(path.join('lib', 'mediawiki.parser.environment.js'), ['MWParserEnvironment']);
	_import(path.join('lib', 'mediawiki.ParsoidConfig.js'), ['ParsoidConfig']);
	_import(path.join('lib', 'mediawiki.parser.js'), ['ParserPipelineFactory']);
	_import(path.join('lib', 'mediawiki.WikitextSerializer.js'), ['WikitextSerializer']);

	var options = {
		fetchTemplates: false,
		debug: false,
		trace: false
	};
	var parsoidConfig = new ParsoidConfig( null, options );

	MWParserEnvironment.getParserEnv( parsoidConfig, null, null, null, function ( err, mwEnv ) {
		if ( err !== null ) {
			console.error( err.toString() );
			process.exit( 1 );
		}
		// "class" properties
		Parsoid.createDocument = function(html) {
			return domino.createDocument(html);
		};
		Parsoid.serializer = new WikitextSerializer({env: mwEnv});
	} );
}

initParsoid();

if (typeof module === "object") {
	module.exports.Parsoid = Parsoid;
}
