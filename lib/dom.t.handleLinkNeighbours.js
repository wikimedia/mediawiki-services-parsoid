"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	JSUtils = require('./jsutils.js').JSUtils;

var findAndHandleNeighbour; // forward declaration

/**
 * Function for fetching the link prefix based on a link node.
 *
 * The content will be reversed, so be ready for that.
 */
function getLinkPrefix( env, node ) {
	var baseAbout = null,
		regex = env.conf.wiki.linkPrefixRegex;

	if ( !regex ) {
		return null;
	}

	if ( node !== null && DU.isTplElementNode( env, node ) ) {
		baseAbout = node.getAttribute( 'about' );
	}

	node = node === null ? node : node.previousSibling;
	return findAndHandleNeighbour( env, false, regex, node, baseAbout );
}

/**
 * Function for fetching the link trail based on a link node.
 */
function getLinkTrail( env, node ) {
	var baseAbout = null,
		regex = env.conf.wiki.linkTrailRegex;

	if ( !regex ) {
		return null;
	}

	if ( node !== null && DU.isTplElementNode( env, node ) ) {
		baseAbout = node.getAttribute( 'about' );
	}

	node = node === null ? node : node.nextSibling;
	return findAndHandleNeighbour( env, true, regex, node, baseAbout );
}

/**
 * Abstraction of both link-prefix and link-trail searches.
 */
findAndHandleNeighbour = function( env, goForward, regex, node, baseAbout ) {
	var value, matches, document, nextSibling,
		nextNode = goForward ? 'nextSibling' : 'previousSibling',
		innerNode = goForward ? 'firstChild' : 'lastChild',
		getInnerNeighbour = goForward ? getLinkTrail : getLinkPrefix,
		result = { content: [], src: '' };

	while ( node !== null ) {
		nextSibling = node[nextNode];
		document = node.ownerDocument;

		if ( DU.isText(node) ) {
			matches = node.nodeValue.match( regex );
			value = { content: node, src: node.nodeValue };
			if ( matches !== null ) {
				value.src = matches[0];
				if ( value.src === node.nodeValue ) {
					// entire node matches linkprefix/trail
					value.content = node;
					DU.deleteNode(node);
				} else {
					// part of node matches linkprefix/trail
					value.content = document.createTextNode( matches[0] );
					node.parentNode.replaceChild( document.createTextNode( node.nodeValue.replace( regex, '' ) ), node );
				}
			} else {
				value.content = null;
				break;
			}
		} else if ( DU.isTplElementNode( env, node ) &&
				baseAbout !== '' && baseAbout !== null &&
				node.getAttribute( 'about' ) === baseAbout ) {
			value = getInnerNeighbour( env, node[innerNode] );
		} else {
			break;
		}

		if ( value.content !== null ) {
			if ( value.content instanceof Array ) {
				result.content = result.content.concat( value.content );
			} else {
				result.content.push( value.content );
			}

			if ( goForward ) {
				result.src += value.src;
			} else {
				result.src = value.src + result.src;
			}

			if ( value.src !== node.nodeValue ) {
				break;
			}
		} else {
			break;
		}
		node = nextSibling;
	}

	return result;
};

/**
 * Workhorse function for bringing linktrails and link prefixes into link content.
 * NOTE that this function mutates the node's siblings on either side.
 */
var linkTypes = JSUtils.arrayToSet([ 'mw:ExtLink', 'mw:WikiLink' ]);
function handleLinkNeighbours( env, node ) {

	var rel = node.getAttribute( 'rel' );
	if ( !linkTypes.has( rel ) ) {
		return true;
	}

	var dp = DU.getDataParsoid( node );
	if ( rel === 'mw:ExtLink' && !dp.isIW ) {
		return true;
	}

	var ix, dataMW, prefix = getLinkPrefix( env, node ),
		trail = getLinkTrail( env, node );

	if ( prefix && prefix.content ) {
		for ( ix = 0; ix < prefix.content.length; ix++ ) {
			node.insertBefore( prefix.content[ix], node.firstChild );
		}
		if ( prefix.src.length > 0 ) {
			dp.prefix = prefix.src;
			if ( DU.isFirstEncapsulationWrapperNode( node ) ) {
				// only necessary if we're the first
				dataMW = DU.getJSONAttribute( node, 'data-mw' );
				dataMW.parts.unshift( prefix.src );
				DU.setJSONAttribute( node, 'data-mw', dataMW );
			}
			if ( dp.dsr ) {
				dp.dsr[0] -= prefix.src.length;
				dp.dsr[2] += prefix.src.length;
			}
		}
	}

	if ( trail && trail.content && trail.content.length ) {
		for ( ix = 0; ix < trail.content.length; ix++ ) {
			node.appendChild( trail.content[ix] );
		}
		if ( trail.src.length > 0 ) {
			dp.tail = trail.src;
			var about = node.getAttribute('about');
			if ( DU.isTplElementNode( env, node ) &&
				DU.getAboutSiblings( node, about ).length === 1
			) {
				// search back for the first wrapper but
				// only if we're the last. otherwise can assume
				// template encapsulation will handle it
				var wrapper = DU.findFirstEncapsulationWrapperNode( node );
				if ( wrapper !== null ) {
					dataMW = DU.getJSONAttribute( wrapper, 'data-mw' );
					dataMW.parts.push( trail.src );
					DU.setJSONAttribute( wrapper, 'data-mw', dataMW );
				}
			}
			if ( dp.dsr ) {
				dp.dsr[1] += trail.src.length;
				dp.dsr[3] += trail.src.length;
			}
		}
		// indicate that the node's tail siblings have been consumed
		return node;
	} else {
		return true;
	}
}

if (typeof module === "object") {
	module.exports.handleLinkNeighbours = handleLinkNeighbours;
}
