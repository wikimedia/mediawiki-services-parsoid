"use strict";

var apiUtils = module.exports = {};


/**
 * Send a redirect response with optional code and a relative URL
 *
 * (Returns if a response has already been sent.)
 * This is not strictly HTTP spec conformant, but works in most clients. More
 * importantly, it works both behind proxies and on the internal network.
 */
apiUtils.relativeRedirect = function(args) {
	if (!args.code) {
		args.code = 302; // moved temporarily
	}

	if (args.res && args.env && args.env.responseSent ) {
		return;
	} else {
		args.res.writeHead(args.code, {
			'Location': args.path
		});
		args.res.end();
	}
};

/**
 * Set header, but only if response hasn't been sent.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Response} res The response object from our routing function.
 * @property {Function} Serializer
 */
apiUtils.setHeader = function(res, env) {
	if (env.responseSent) {
		return;
	} else {
		res.setHeader.apply(res, Array.prototype.slice.call(arguments, 2));
	}
};

/**
 * End response, but only if response hasn't been sent.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Response} res The response object from our routing function.
 * @property {Function} Serializer
 */
apiUtils.endResponse = function(res, env) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.end.apply(res, Array.prototype.slice.call(arguments, 2));
		env.log("end/response");
	}
};

/**
 * Send response, but only if response hasn't been sent.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Response} res The response object from our routing function.
 * @property {Function} Serializer
 */
apiUtils.sendResponse = function(res, env) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.send.apply(res, Array.prototype.slice.call(arguments, 2));
	}
};

/**
 * Render response, but only if response hasn't been sent.
 */
apiUtils.renderResponse = function(res, env) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.render.apply(res, Array.prototype.slice.call(arguments, 2));
	}
};

apiUtils.jsonResponse = function(res, env) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.json.apply(res, Array.prototype.slice.call(arguments, 2));
	}
};

apiUtils.htmlSpecialChars = function( s ) {
	return s.replace(/&/g,'&amp;')
		.replace(/</g,'&lt;')
		.replace(/"/g,'&quot;')
		.replace(/'/g,'&#039;');
};
