// This file is used to run a stub API that mimicks the MediaWiki interface
// for the purposes of testing extension expansion.
var express = require('express');

/* -------------------- web app access points below --------------------- */

var app = express.createServer();

app.use( express.bodyParser() );

function sanitizeHTMLAttribute( text ) {
	return text
		.replace( /&/g, '&amp;' )
		.replace( /"/g, '&quot;' )
		.replace( /</g, '&lt;' )
		.replace( />/g, '&gt;' );
}

var formatters = {
		json: function ( data ) {
			return JSON.stringify( data );
		},
		jsonfm: function ( data ) {
			return JSON.stringify( data, null, 2 );
		}
	},

	availableActions = {
		parse: function ( body, cb ) {
			var resultText,
				text = body.text,
				re = /<testextension(?: ([^>]*))?>((?:[^<]|<(?!\/testextension>))*)<\/testextension>/,
				replaceString = '<p data-options="$1">$2</p>',
				result = text.match( re );

			// I guess this doesn't need to be a function anymore, but still.
			function handleTestExtension( opts, content ) {
				var i, opt, optHash = {};

				opts = opts.split( / +/ );
				for ( i = 0; i < opts.length; i++ ) {
					opt = opts[i].split( '=' );
					optHash[opt[0]] = opt[1].trim().replace( /(^"|"*$)/g, '' );
				}

				return replaceString.replace( '$1', sanitizeHTMLAttribute( JSON.stringify( optHash ) ) )
					.replace( '$2', sanitizeHTMLAttribute( content ) );
			}

			if ( result ) {
				resultText = handleTestExtension( result[1], result[2] );
			} else {
				resultText = body.text;
			}

			cb( null, { parse: { text: { '*': resultText } } } );
		}
	},

	actionDefinitions = {
		parse: {
			parameters: {
				text: 'text',
				title: 'text'
			}
		}
	},

	actionRegex = Object.keys( availableActions ).join( '|' );

function buildOptions( options ) {
	var i, optStr = '';

	for ( i = 0; i < options.length; i++ ) {
		optStr += '<option value="' + options[i] + '">' + options[i] + '</option>';
	}

	return optStr;
}

function buildActionList() {
	var i, action, title,
		actions = Object.keys( availableActions ),
		setStr = '';

	for ( i = 0; i < actions.length; i++ ) {
		action = actions[i];
		title = 'action=' + action;
		setStr += '<li id="' + title + '">';
		setStr += '<a href="/' + action + '">' + title + '</a></li>';
	}

	return setStr;
}

function buildForm( action ) {
	var i, actionDef, param, params, paramList,
		formStr = '';

	actionDef = actionDefinitions[action];
	params = actionDef.parameters;
	paramList = Object.keys( params );

	for ( i = 0; i < paramList.length; i++ ) {
		param = paramList[i];
		if ( typeof params[param] === 'string' ) {
			formStr += '<input type="' + params[param] + '" name="' + param + '" />';
		} else if ( params[param].length ) {
			formStr += '<select name="' + param + '">';
			formStr += buildOptions( params[param] );
			formStr += '</select>';
		}
	}
	return formStr;
}

// GET request to root....should probably just tell the client how to use the service
app.get( '/', function ( req, res ) {
	res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
	res.write(
		'<html><body>' +
			'<ul id="list-of-actions">' +
				buildActionList() +
			'</ul>' +
		'</body></html>' );
	res.end();
} );

// GET requests for any possible actions....tell the client how to use the action
app.get( new RegExp( '^/(' + actionRegex + ')' ), function ( req, res ) {
	var formats = buildOptions( Object.keys( formatters ) ),
		action = req.params[0],
		returnHtml =
			'<form id="service-form" method="GET" action="api.php">' +
				'<h2>GET form</h2>' +
				'<input name="action" type="hidden" value="' + action + '" />' +
				'<select name="format">' +
					formats +
				'</select>' +
				buildForm( action ) +
				'<input type="submit" />' +
			'</form>' +
			'<form id="service-form" method="POST" action="api.php">' +
				'<h2>POST form</h2>' +
				'<input name="action" type="hidden" value="' + action + '" />' +
				'<select name="format">' +
					formats +
				'</select>' +
				buildForm( action ) +
				'<input type="submit" />' +
			'</form>';

	res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
	res.write( returnHtml );
	res.end();
} );

function handleApiRequest( body, res ) {
	var format = body.format,
		action = body.action,
		formatter = formatters[format];

	availableActions[action]( body, function ( err, data ) {
		if ( err === null ) {
			res.setHeader( 'Content-Type', 'application/json' );
			res.write( formatter( data ) );
			res.end();
		} else {
			res.setHeader( 'Content-Type', 'text/plain' );

			if ( err.code ) {
				res.status( err.code );
			} else {
				res.status( 500 );
			}

			res.write( err.stack || err.toString() );
			res.end();
		}
	} );
}

// GET request to api.php....actually perform an API request
app.get( '/api.php', function ( req, res ) {
	handleApiRequest( req.query, res );
} );

// POST request to api.php....actually perform an API request
app.post( '/api.php', function ( req, res ) {
	handleApiRequest( req.body, res );
} );

module.exports = app;

console.log( 'Mock MediaWiki API starting....' );
app.listen( 7001 );
console.log( 'Started.' );
