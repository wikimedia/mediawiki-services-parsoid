'use strict';

const { CommentTk } = require('./CommentTk.js');
const { EndTagTk } = require('./EndTagTk.js');
const { EOFTk } = require('./EOFTk.js');
const { KV } = require('./KV.js');
const { NlTk } = require('./NlTk.js');
const { TagTk } = require('./TagTk.js');
const { Token } = require('./Token.js');
const { SelfclosingTagTk } = require('./SelfclosingTagTk.js');

if (typeof module === "object") {
	module.exports = {
		CommentTk,
		EndTagTk,
		EOFTk,
		KV,
		NlTk,
		TagTk,
		Token,
		SelfclosingTagTk,
	};
}
