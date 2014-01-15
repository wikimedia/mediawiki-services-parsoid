/**
 * Example configuration for the testing client.
 *
 * Copy this file to config.js and change the values as needed.
 */
"use strict";

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

		// By default, use the same configuration as the testing Parsoid server.
		setup: require( '../test.localsettings.js').setup,

		// The parsoid API to use. If null, create our own server
		parsoidURL: null
	};
}

}() );
