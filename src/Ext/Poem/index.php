<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module ext/Poem */

namespace Parsoid;

$ParsoidExtApi = $module->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );
$DOMUtils = ParsoidExtApi\DOMUtils;

$dummyDoc = DOMUtils::parseHTML( '' );
$toDOM = function ( $state, $content, $args ) use ( &$ParsoidExtApi ) {
	if ( $content && count( $content ) > 0 ) {
		$content = preg_replace(

			'/^ /m', '&nbsp;', preg_replace(

				'/\n$/', '', preg_replace(

					'/^\n/', '', $content,
					// Strip leading/trailing newline
					 1
				), 1
			)
			// Suppress indent-pre by replacing leading space with &nbsp;
		);
		// Add <br/> for newlines except (a) in nowikis (b) after ----
		// nowiki newlines will be processed on the DOM.
		$content = implode(

			'', array_map( preg_split( '/(<nowiki>[\s\S]*?<\/nowiki>)/', $content ), function ( $p, $i ) {
					if ( $i % 2 === 1 ) {
						return $p;
					}

					// This is a hack that exploits the fact that </poem>
					// cannot show up in the extension's content.
					// When we switch to node v8, we can use a negative lookbehind if we want.
					// https://v8project.blogspot.com/2016/02/regexp-lookbehind-assertions.html
					// This is a hack that exploits the fact that </poem>
					// cannot show up in the extension's content.
					// When we switch to node v8, we can use a negative lookbehind if we want.
					// https://v8project.blogspot.com/2016/02/regexp-lookbehind-assertions.html
					return preg_replace(

						'/^(-+)<\/poem>/m', "\$1\n", preg_replace(
							'/\n/m', "<br/>\n", preg_replace( '/(^----+)\n/m', '$1</poem>', $p ) )
					);
			}
			)

		);
		// Replace colons with indented spans
		$content = preg_replace( '/^(:+)(.+)$/', function ( $match, $colons, $verse ) {
				$span = $dummyDoc->createElement( 'span' );
				$span->setAttribute( 'class', 'mw-poem-indented' );
				$span->setAttribute( 'style', 'display: inline-block; margin-left: ' . count( $colons ) . 'em;' );
				$span->appendChild( $dummyDoc->createTextNode( $verse ) );
				return $span->outerHTML;
		}, $content );
	}

	return ParsoidExtApi::parseTokenContentsToDOM( $state, $args, '', $content, [
			'wrapperTag' => 'div',
			'extTag' => 'poem'
		]
	);
};

function processNowikis( $node ) {
	global $DOMUtils;
	$doc = $node->ownerDocument;
	$c = $node->firstChild;
	while ( $c ) {
		if ( !DOMUtils::isElt( $c ) ) {
			$c = $c->nextSibling;
			continue;
		}

		if ( !preg_match( '/\bmw:Nowiki\b/', $c->getAttribute( 'typeof' ) ) ) {
			processNowikis( $c );
			$c = $c->nextSibling;
			continue;
		}

		// Replace nowiki's text node with a combination
		// of content and <br/>s. Take care to deal with
		// entities that are still entity-wrapped (!!).
		$cc = $c->firstChild;
		while ( $cc ) {
			$next = $cc->nextSibling;
			if ( DOMUtils::isText( $cc ) ) {
				$pieces = preg_split( '/\n/', $cc->nodeValue );
				$n = count( $pieces );
				$nl = '';
				for ( $i = 0;  $i < $n;  $i++ ) {
					$p = $pieces[ $i ];
					$c->insertBefore( $doc->createTextNode( $nl + $p ), $cc );
					if ( $i < $n - 1 ) {
						$c->insertBefore( $doc->createElement( 'br' ), $cc );
						$nl = "\n";
					}
				}
				$c->removeChild( $cc );
			}
			$cc = $next;
		}
		$c = $c->nextSibling;
	}
}

// FIXME: We could expand the parseTokenContentsToDOM helper to let us
// pass in a handler that post-processes the DOM immediately,
// instead of in the end.
$_domPostProcessor = function ( $node, $env, $options, $atTopLevel ) use ( &$DOMUtils, &$_domPostProcessor ) {
	if ( !$atTopLevel ) {
		return;
	}

	$c = $node->firstChild;
	while ( $c ) {
		if ( DOMUtils::isElt( $c ) ) {
			if ( preg_match( '/\bmw:Extension\/poem\b/', $c->getAttribute( 'typeof' ) ) ) {
				// In nowikis, replace newlines with <br/>.
				// Cannot do it before parsing because <br/> will get escaped!
				processNowikis( $c );
			} else {
				$_domPostProcessor( $c, $env, $options, $atTopLevel );
			}
		}
		$c = $c->nextSibling;
	}
};

/*
const serialHandler = {
handle: Promise.method(function(node, state, wrapperUnmodified) {
// Initially, we will let the default extension
// html2wt handler take care of this.
//
// If VE starts supporting editing of poem content
// natively, we can add a custom html2wt handler.
}),
};
*/

$module->exports = function () use ( &$_domPostProcessor, &$toDOM ) {
	$this->config = [
		'name' => 'poem',
		'domProcessors' => [
			'wt2htmlPostProcessor' => $_domPostProcessor
		],
		'tags' => [
			[
				'name' => 'poem',
				'toDOM' => $toDOM
			]
		]
	];
};
