/**
 * Example configuration for the testing client.
 *
 * Copy this file to config.js and change the values as needed.
 */

( function () {

if ( typeof module === 'object' ) {
	module.exports = {
		server: {
			// The address of the master HTTP server (for getting titles and posting results) (no protocol)
			host: 'localhost',

			// The port where the server is running
			port: 8002
		},

		// A unique name for this client (optional) (URL-safe characters only)
		clientName: 'AnonymousClient',

		interwiki: 'en',

		setup: function ( parsoidConfig ) {
			// Whether to use the PHP preprocessor to expand templates and the like
			parsoidConfig.usePHPPreProcessor = true;

			// The interwiki prefix you want to use (see mediawiki.parser.environment.js for more information)
			parsoidConfig.defaultWiki = 'en';

			// Insert the interwiki prefix for a localhost wiki
			parsoidConfig.setInterwiki( 'localhost', 'http://localhost/wiki/api.php' );
		}
	};
}

}() );
