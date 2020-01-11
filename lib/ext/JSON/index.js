/**
 * This is a demonstration of content model handling in extensions for
 * Parsoid.  It implements the "json" content model, to allow editing
 * JSON data structures using Visual Editor.  It represents the JSON
 * structure as a nested table.
 * @module ext/JSON
 */

'use strict';

const ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.11.0');
const {
	DOMDataUtils,
	DOMUtils,
	Promise,
	addMetaData,
} = ParsoidExtApi;

/**
 * Native Parsoid implementation of the "json" contentmodel.
 * @class
 */
var JSONExt = function() {
	/** @type {Object} */
	this.config = {
		contentmodels: {
			json: this,
		},
	};
};

var PARSE_ERROR_HTML =
	'<!DOCTYPE html><html>' +
	'<body>' +
	'<table data-mw=\'{"errors":[{"key":"bad-json"}]}\' typeof="mw:Error">' +
	'</body>';

/**
 * JSON to HTML.
 * Implementation matches that from includes/content/JsonContent.php in
 * mediawiki core, except that we add some additional classes to distinguish
 * value types.
 * @param {MWParserEnvironment} env
 * @return {Document}
 * @method
 */
JSONExt.prototype.toHTML = Promise.method(function(env) {
	var document = env.createDocument('<!DOCTYPE html><html><body>');
	var rootValueTable;
	var objectTable;
	var objectRow;
	var arrayTable;
	var valueCell;
	var primitiveValue;
	var src;

	rootValueTable = function(parent, val) {
		if (Array.isArray(val)) {
			// Wrap arrays in another array so they're visually boxed in a
			// container.  Otherwise they are visually indistinguishable from
			// a single value.
			return arrayTable(parent, [ val ]);
		}
		if (val && typeof val === "object") {
			return objectTable(parent, val);
		}
		parent.innerHTML =
			'<table class="mw-json mw-json-single-value"><tbody><tr><td>';
		return primitiveValue(parent.querySelector('td'), val);
	};
	objectTable = function(parent, val) {
		parent.innerHTML = '<table class="mw-json mw-json-object"><tbody>';
		var tbody = parent.firstElementChild.firstElementChild;
		var keys = Object.keys(val);
		if (keys.length) {
			keys.forEach(function(k) {
				objectRow(tbody, k, val[k]);
			});
		} else {
			tbody.innerHTML =
				'<tr><td class="mw-json-empty">';
		}
	};
	objectRow = function(parent, key, val) {
		var tr = document.createElement('tr');
		if (key !== undefined) {
			var th = document.createElement('th');
			th.textContent = key;
			tr.appendChild(th);
		}
		valueCell(tr, val);
		parent.appendChild(tr);
	};
	arrayTable = function(parent, val) {
		parent.innerHTML = '<table class="mw-json mw-json-array"><tbody>';
		var tbody = parent.firstElementChild.firstElementChild;
		if (val.length) {
			for (var i = 0; i < val.length; i++) {
				objectRow(tbody, undefined, val[i]);
			}
		} else {
			tbody.innerHTML =
				'<tr><td class="mw-json-empty">';
		}
	};
	valueCell = function(parent, val) {
		var td = document.createElement('td');
		if (Array.isArray(val)) {
			arrayTable(td, val);
		} else if (val && typeof val === 'object') {
			objectTable(td, val);
		} else {
			td.classList.add('value');
			primitiveValue(td, val);
		}
		parent.appendChild(td);
	};
	primitiveValue = function(parent, val) {
		if (val === null) {
			parent.classList.add('mw-json-null');
		} else if (val === true || val === false) {
			parent.classList.add('mw-json-boolean');
		} else if (typeof val === 'number') {
			parent.classList.add('mw-json-number');
		} else if (typeof val === 'string') {
			parent.classList.add('mw-json-string');
		}
		parent.textContent = '' + val;
	};

	try {
		src = JSON.parse(env.page.src);
		rootValueTable(document.body, src);
	} catch (e) {
		document = env.createDocument(PARSE_ERROR_HTML);
	}
	// We're responsible for running the standard DOMPostProcessor on our
	// resulting document.
	if (env.pageBundle) {
		DOMDataUtils.visitAndStoreDataAttribs(document.body, {
			storeInPageBundle: env.pageBundle,
			env: env,
		});
	}
	addMetaData(env, document);
	return document;
});

/**
 * HTML to JSON.
 * @param {MWParserEnvironment} env
 * @param {Node} body
 * @param {boolean} useSelser
 * @return {string}
 * @method
 */
JSONExt.prototype.fromHTML = Promise.method(function(env, body, useSelser) {
	var rootValueTable;
	var objectTable;
	var objectRow;
	var arrayTable;
	var valueCell;
	var primitiveValue;

	console.assert(DOMUtils.isBody(body), 'Expected a body node.');

	rootValueTable = function(el) {
		if (el.classList.contains('mw-json-single-value')) {
			return primitiveValue(el.querySelector('tr > td'));
		} else if (el.classList.contains('mw-json-array')) {
			return arrayTable(el)[0];
		} else {
			return objectTable(el);
		}
	};
	objectTable = function(el) {
		console.assert(el.classList.contains('mw-json-object'));
		var tbody = el;
		if (
			tbody.firstElementChild &&
			tbody.firstElementChild.tagName === 'TBODY'
		) {
			tbody = tbody.firstElementChild;
		}
		var rows = tbody.children;
		var obj = {};
		var empty = rows.length === 0 || (
			rows[0].firstElementChild &&
			rows[0].firstElementChild.classList.contains('mw-json-empty')
		);
		if (!empty) {
			for (var i = 0; i < rows.length; i++) {
				objectRow(rows[i], obj, undefined);
			}
		}
		return obj;
	};
	objectRow = function(tr, obj, key) {
		var td = tr.firstElementChild;
		if (key === undefined) {
			key = td.textContent;
			td = td.nextElementSibling;
		}
		obj[key] = valueCell(td);
	};
	arrayTable = function(el) {
		console.assert(el.classList.contains('mw-json-array'));
		var tbody = el;
		if (
			tbody.firstElementChild &&
			tbody.firstElementChild.tagName === 'TBODY'
		) {
			tbody = tbody.firstElementChild;
		}
		var rows = tbody.children;
		var arr = [];
		var empty = rows.length === 0 || (
			rows[0].firstElementChild &&
			rows[0].firstElementChild.classList.contains('mw-json-empty')
		);
		if (!empty) {
			for (var i = 0; i < rows.length; i++) {
				objectRow(rows[i], arr, i);
			}
		}
		return arr;
	};
	valueCell = function(el) {
		console.assert(el.tagName === 'TD');
		var table = el.firstElementChild;
		if (table && table.classList.contains('mw-json-array')) {
			return arrayTable(table);
		} else if (table && table.classList.contains('mw-json-object')) {
			return objectTable(table);
		} else {
			return primitiveValue(el);
		}
	};
	primitiveValue = function(el) {
		if (el.classList.contains('mw-json-null')) {
			return null;
		} else if (el.classList.contains('mw-json-boolean')) {
			return /true/.test(el.textContent);
		} else if (el.classList.contains('mw-json-number')) {
			return +el.textContent;
		} else if (el.classList.contains('mw-json-string')) {
			return '' + el.textContent;
		} else {
			return undefined; // shouldn't happen.
		}
	};
	var t = body.firstElementChild;
	console.assert(t && t.tagName === 'TABLE');
	return JSON.stringify(rootValueTable(t), null, 4);
});

if (typeof module === "object") {
	module.exports = JSONExt;
}
