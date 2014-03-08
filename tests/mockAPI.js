// This file is used to run a stub API that mimicks the MediaWiki interface
// for the purposes of testing extension expansion.
"use strict";

var express = require('express');
var crypto = require('crypto');

// configuration to match PHP parserTests
var IMAGE_BASE_URL = 'http://example.com/images';
var IMAGE_DESC_URL = IMAGE_BASE_URL;
//IMAGE_BASE_URL='http://upload.wikimedia.org/wikipedia/commons';
//IMAGE_DESC_URL='http://commons.wikimedia.org/wiki';
var FILE_PROPS = {
	'Foobar.jpg': {
		size: 7881, width: 1941, height: 220, bits: 8, mime: 'image/jpeg'
	},
	'Thumb.png': {
		size: 22589, width: 135, height: 135, bits: 8, mime: 'image/png'
	},
	'Foobar.svg': {
		size: 12345, width: 240, height: 180, bits: 24, mime: 'image/svg+xml'
	}
};

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

var fnames = {
		'Image:Foobar.jpg': 'Foobar.jpg',
		'File:Foobar.jpg': 'Foobar.jpg',
		'Image:Foobar.svg': 'Foobar.svg',
		'File:Foobar.svg': 'Foobar.svg',
		'Image:Thumb.png': 'Thumb.png',
		'File:Thumb.png': 'Thumb.png'
	},

	pnames = {
		'Image:Foobar.jpg': 'File:Foobar.jpg',
		'Image:Foobar.svg': 'File:Foobar.svg',
		'Image:Thumb.png': 'File:Thumb.png'
	},

	formatters = {
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
		},

		query: function ( body, cb ) {
			var filename = body.titles,
				normPagename = pnames[filename] || filename,
				normFilename = fnames[filename] || filename;
			if(!(normFilename in FILE_PROPS )) {
				cb( null, {
					'query': {
						'pages': {
							'-1': {
								'ns': 6,
								'title': filename,
								'missing': '',
								'imagerepository': ''
							}
						}
					}
				} );
				return;
			}
			var props = FILE_PROPS[normFilename] || Object.create(null);
			var md5 = crypto.createHash('md5').update(normFilename).
				digest('hex');
			var md5prefix = md5[0] + '/' + md5[0] + md5[1] + '/';
			var baseurl = IMAGE_BASE_URL + '/' + md5prefix + normFilename,
				height = props.height || 220,
				width = props.width || 1941,
				twidth = body.iiurlwidth,
				theight = body.iiurlheight,
				turl = IMAGE_BASE_URL + '/thumb/' + md5prefix + normFilename,
				durl = IMAGE_DESC_URL + '/' + normFilename,
				imageinfo = {
					pageid: 1,
					ns: 6,
					title: normPagename,
					imageinfo: [ {
						size: props.size || 12345,
						height: height,
						width: width,
						url: baseurl,
						descriptionurl: durl
					} ]
				},
				response = {
					query: {
						normalized: [ {
							from: filename,
							to: normPagename
						} ],
						pages: {}
					}
				};

			if ( twidth || theight ) {
				if ( twidth && (theight === undefined || theight === null) ) {
					// File::scaleHeight in PHP
					theight = Math.round( height * twidth / width );
				} else if ( theight && (twidth === undefined || twidth === null) ) {
					// MediaHandler::fitBoxWidth in PHP
					// This is crazy!
					var idealWidth = width * theight / height;
					var roundedUp = Math.ceil(idealWidth);
					if (Math.round(roundedUp * height / width) > theight) {
						twidth = Math.floor(idealWidth);
					} else {
						twidth = roundedUp;
					}
				} else {
					if ( Math.round( height * twidth / width ) > theight ) {
						twidth = Math.ceil( width * theight / height );
					} else {
						theight = Math.round( height * twidth / width );
					}
				}
				if (twidth >= width || theight >= height) {
					// the PHP api won't enlarge an image
					twidth = width;
					theight = height;
				}

				turl += '/' + twidth + 'px-' + normFilename;
				imageinfo.imageinfo[0].thumbwidth = twidth;
				imageinfo.imageinfo[0].thumbheight = theight;
				imageinfo.imageinfo[0].thumburl = turl;
			}

			response.query.pages['1'] = imageinfo;
			cb( null, response );
		}
	},

	actionDefinitions = {
		parse: {
			parameters: {
				text: 'text',
				title: 'text'
			}
		},

		query: {
			parameters: {
				titles: 'text',
				prop: 'text',
				iiprop: 'text',
				iiurlwidth: 'text',
				iiurlheight: 'text'
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

var port = process.env.PORT || 7001;
console.log( 'Mock MediaWiki API starting.... listening to ' + port);
app.listen(port);
console.log( 'Started.' );
