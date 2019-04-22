<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Wikitext to HTML serializer.
 *
 * This serializer is designed to eventually
 * - accept arbitrary HTML and
 * - serialize that to wikitext in a way that round-trips back to the same
 *   HTML DOM as far as possible within the limitations of wikitext.
 *
 * Not much effort has been invested so far on supporting
 * non-Parsoid/VE-generated HTML. Some of this involves adaptively switching
 * between wikitext and HTML representations based on the values of attributes
 * and DOM context. A few special cases are already handled adaptively
 * (multi-paragraph list item contents are serialized as HTML tags for
 * example, generic A elements are serialized to HTML A tags), but in general
 * support for this is mostly missing.
 *
 * Example issue:
 * ```
 * <h1><p>foo</p></h1> will serialize to =\nfoo\n= whereas the
 *        correct serialized output would be: =<p>foo</p>=
 * ```
 *
 * What to do about this?
 * * add a generic 'can this HTML node be serialized to wikitext in this
 *   context' detection method and use that to adaptively switch between
 *   wikitext and HTML serialization.
 * @module
 */

namespace Parsoid;



use Parsoid\ContentUtils as ContentUtils;
use Parsoid\ConstrainedText as ConstrainedText;
use Parsoid\DiffUtils as DiffUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMNormalizer as DOMNormalizer;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\JSUtils as JSUtils;
use Parsoid\KV as KV;
use Parsoid\TagTk as TagTk;
use Parsoid\TemplateDataRequest as TemplateDataRequest;
use Parsoid\TokenUtils as TokenUtils;
use Parsoid\Util as Util;
use Parsoid\WikitextEscapeHandlers as WikitextEscapeHandlers;
use Parsoid\WTSUtils as WTSUtils;
use Parsoid\WTUtils as WTUtils;
use Parsoid\SerializerState as SerializerState;

use Parsoid\WikitextConstants as Consts;
use Parsoid\TagHandlers as TagHandlers;
use Parsoid\HtmlElementHandler as HtmlElementHandler;
use Parsoid\_getEncapsulatedContentHandler as _getEncapsulatedContentHandler;
use Parsoid\LinkHandlersModule as LinkHandlersModule;
use Parsoid\LanguageVariantHandler as LanguageVariantHandler;
use Parsoid\Promise as Promise;
use Parsoid\SeparatorsModule as SeparatorsModule;

$temp0 = JSUtils::class; $lastItem = $temp0->lastItem;

/* Used by WikitextSerializer._serializeAttributes */
$IGNORED_ATTRIBUTES = new Set( [
		'data-parsoid',
		'data-ve-changed',
		'data-parsoid-changed',
		'data-parsoid-diff',
		'data-parsoid-serialize',
		DOMDataUtils\DataObjectAttrName()
	]
);

/* Used by WikitextSerializer._serializeAttributes */
$PARSOID_ATTRIBUTES = new Map( [
		[ 'about', /* RegExp */ '/^#mwt\d+$/' ],
		[ 'typeof', /* RegExp */ '/(^|\s)mw:[^\s]+/g' ]
	]
);

$TRAILING_COMMENT_OR_WS_AFTER_NL_REGEXP = JSUtils::rejoin(
	'\n(\s|', Util\COMMENT_REGEXP, ')*$'
);

$FORMATSTRING_REGEXP =
/* RegExp */ '/^(\n)?(\{\{ *_+)(\n? *\|\n? *_+ *= *)(_+)(\n? *\}\})(\n)?$/';

// Regular expressions for testing if nowikis added around
// heading-like wikitext are spurious or necessary.
$COMMENT_OR_WS_REGEXP = JSUtils::rejoin(
	'^(\s|', Util\COMMENT_REGEXP, ')*$'
);

$HEADING_NOWIKI_REGEXP = JSUtils::rejoin(
	'^(?:', Util\COMMENT_REGEXP, ')*',
	/* RegExp */ '/<nowiki>(=+[^=]+=+)<\/nowiki>(.+)$/'
);

$PHPDOMPass = null;

/**
 * Serializes a chunk of tokens or an HTML DOM to MediaWiki's wikitext flavor.
 *
 * @class
 * @param {Object} options List of options for serialization.
 * @param {MWParserEnvironment} options.env
 * @param {boolean} [options.rtTestMode]
 * @param {string} [options.logType="trace/wts"]
 * @alias module:html2wt/WikitextSerializer~WikitextSerializer
 */
class WikitextSerializer {
	public function __construct( $options ) {
		$this->options = $options;
		$this->env = $options->env;

		// Set rtTestMode if not already set.
		if ( $this->options->rtTestMode === null ) {
			$this->options->rtTestMode = $this->env->conf->parsoid->rtTestMode;
		}

		$this->state = new SerializerState( $this, $this->options );

		$this->logType = $this->options->logType || 'trace/wts';
		$this->trace = function ( ...$args ) {return  $this->env->log( $this->logType, ...$args ); };

		// WT escaping handlers
		$this->wteHandlers = new WikitextEscapeHandlers( $this->options );

		// Used in multiple tag handlers, and hence added as top-level properties
		// - linkHandler is used by <a> and <link>
		// - figureHandler is used by <figure> and by <a>.linkHandler above
		$this->linkHandler = LinkHandlersModule::linkHandler;
		$this->figureHandler = LinkHandlersModule::figureHandler;

		$this->languageVariantHandler = LanguageVariantHandler::languageVariantHandler;

		// Separator handling
		$this->updateSeparatorConstraints = SeparatorsModule::updateSeparatorConstraints;
		$this->buildSep = SeparatorsModule::buildSep;
	}
	public $options;
	public $env;



	public $rtTestMode;


	public $state;

	public $logType;
	public $trace;


	public $wteHandlers;




	public $linkHandler;
	public $figureHandler;

	public $languageVariantHandler;


	public $updateSeparatorConstraints;
	public $buildSep;

}

// Methods

/**
 * @param {Object} opts
 * @param {Node} html
 */
WikitextSerializer::prototype::serializeHTML = /* async */function ( $opts, $html ) use ( &$ContentUtils ) {
	$opts->logType = $this->logType;
	$body = ContentUtils::ppToDOM( $this->env, $html, [ 'markNew' => true ] );
	return /* await */ ( new WikitextSerializer( $opts ) )->serializeDOM( $body );
}



;

WikitextSerializer::prototype::getAttributeKey = /* async */function ( $node, $key ) use ( &$DOMDataUtils ) {
	$tplAttrs = DOMDataUtils::getDataMw( $node )->attribs;
	if ( $tplAttrs ) {
		// If this attribute's key is generated content,
		// serialize HTML back to generator wikitext.
		for ( $i = 0;  $i < count( $tplAttrs );  $i++ ) {
			$a = $tplAttrs[ $i ];
			if ( $a[ 0 ]->txt === $key && $a[ 0 ]->html ) {
				return /* await */ $this->serializeHTML( [
						'env' => $this->env,
						'onSOL' => false
					], $a[ 0 ]->html
				);
			}
		}
	}
	return $key;
}















;

WikitextSerializer::prototype::getAttributeValue = /* async */function ( $node, $key, $value ) use ( &$DOMDataUtils, &$undefined ) {
	$tplAttrs = DOMDataUtils::getDataMw( $node )->attribs;
	if ( $tplAttrs ) {
		// If this attribute's value is generated content,
		// serialize HTML back to generator wikitext.
		for ( $i = 0;  $i < count( $tplAttrs );  $i++ ) {
			$a = $tplAttrs[ $i ];
			if ( ( $a[ 0 ] === $key || $a[ 0 ]->txt === $key )
&&					// !== null is required. html:"" will serialize to "" and
					// will be returned here. This is used to suppress the =".."
					// string in the attribute in scenarios where the template
					// generates a "k=v" string.
					// Ex: <div {{echo|1=style='color:red'}}>foo</div>
					$a[ 1 ]->html !== null
&&					// Only return here if the value is generated (ie. .html),
					// it may just be in .txt form.
					$a[ 1 ]->html !== null
			) {
				return /* await */ $this->serializeHTML( [
						'env' => $this->env,
						'onSOL' => false,
						'inAttribute' => true
					], $a[ 1 ]->html
				);
			}
		}
	}
	return $value;
}

























;

WikitextSerializer::prototype::serializedAttrVal = /* async */function ( $node, $name ) {
	return /* await */ $this->serializedImageAttrVal( $node, $node, $name );
}

;

WikitextSerializer::prototype::getAttributeValueAsShadowInfo = /* async */function ( $node, $key ) {
	$v = /* await */ $this->getAttributeValue( $node, $key, null );
	if ( $v === null ) { return $v;  }
	return [
		'value' => $v,
		'modified' => false,
		'fromsrc' => true,
		'fromDataMW' => true
	];
}








;

WikitextSerializer::prototype::serializedImageAttrVal = /* async */function ( $dataMWnode, $htmlAttrNode, $key ) use ( &$WTSUtils ) {
	$v = /* await */ $this->getAttributeValueAsShadowInfo( $dataMWnode, $key );
	return $v || WTSUtils::getAttributeShadowInfo( $htmlAttrNode, $key );
}


;

WikitextSerializer::prototype::_serializeHTMLTag = /* async */function ( $node, $wrapperUnmodified ) use ( &$WTSUtils, &$DOMDataUtils, &$Util, &$WTUtils ) {
	// TODO(arlolra): As of 1.3.0, html pre is considered an extension
	// and wrapped in encapsulation.  When that version is no longer
	// accepted for serialization, we can remove this backwards
	// compatibility code.
	//
	// 'inHTMLPre' flag has to be updated always,
	// even when we are selsering in the wrapperUnmodified case.
	$token = WTSUtils::mkTagTk( $node );
	if ( $token->name === 'pre' ) {
		// html-syntax pre is very similar to nowiki
		$this->state->inHTMLPre = true;
	}

	if ( $wrapperUnmodified ) {
		$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
		return $this->state->getOrigSrc( $dsr[ 0 ], $dsr[ 0 ] + $dsr[ 2 ] );
	}

	$da = $token->dataAttribs;
	if ( $da->autoInsertedStart ) {
		return '';
	}

	$close = '';
	if ( ( Util::isVoidElement( $token->name ) && !$da->noClose ) || $da->selfClose ) {
		$close = ' /';
	}

	$sAttribs = /* await */ $this->_serializeAttributes( $node, $token );
	if ( count( $sAttribs ) > 0 ) {
		$sAttribs = ' ' . $sAttribs;
	}

	$tokenName = $da->srcTagName || $token->name;
	$ret = "<{$tokenName}{$sAttribs}{$close}>";

	if ( strtolower( $tokenName ) === 'nowiki' ) {
		$ret = WTUtils::escapeNowikiTags( $ret );
	}

	return $ret;
}









































;

WikitextSerializer::prototype::_serializeHTMLEndTag = Promise::method( function ( $node, $wrapperUnmodified ) use ( &$DOMDataUtils, &$WTSUtils, &$Util, &$WTUtils ) {
		if ( $wrapperUnmodified ) {
			$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
			return $this->state->getOrigSrc( $dsr[ 1 ] - $dsr[ 3 ], $dsr[ 1 ] );
		}

		$token = WTSUtils::mkEndTagTk( $node );
		if ( $token->name === 'pre' ) {
			$this->state->inHTMLPre = false;
		}

		$tokenName = $token->dataAttribs->srcTagName || $token->name;
		$ret = '';

		if ( !$token->dataAttribs->autoInsertedEnd
&&				!Util::isVoidElement( $token->name )
&&				!$token->dataAttribs->selfClose
		) {
			$ret = "</{$tokenName}>";
		}

		if ( strtolower( $tokenName ) === 'nowiki' ) {
			$ret = WTUtils::escapeNowikiTags( $ret );
		}

		return $ret;
	}
);

WikitextSerializer::prototype::_serializeAttributes = /* async */function ( $node, $token, $isWt ) use ( &$IGNORED_ATTRIBUTES, &$WTUtils, &$DOMDataUtils, &$Consts, &$PARSOID_ATTRIBUTES, &$KV ) {
	$attribs = $token->attribs;

	$out = [];
	foreach ( $attribs as $kv => $___ ) {
		$k = $kv->k;
		$v = null; $vInfo = null;

		// Unconditionally ignore
		// (all of the IGNORED_ATTRIBUTES should be filtered out earlier,
		// but ignore them here too just to make sure.)
		// Unconditionally ignore
		// (all of the IGNORED_ATTRIBUTES should be filtered out earlier,
		// but ignore them here too just to make sure.)
		if ( IGNORED_ATTRIBUTES::has( $k ) || $k === 'data-mw' ) {
			continue;
		}

		// Ignore parsoid-like ids. They may have been left behind
		// by clients and shouldn't be serialized. This can also happen
		// in v2/v3 API when there is no matching data-parsoid entry found
		// for this id.
		// Ignore parsoid-like ids. They may have been left behind
		// by clients and shouldn't be serialized. This can also happen
		// in v2/v3 API when there is no matching data-parsoid entry found
		// for this id.
		if ( $k === 'id' && preg_match( '/^mw[\w-]{2,}$/', $kv->v ) ) {
			if ( WTUtils::isNewElt( $node ) ) {
				$this->env->log( 'warn/html2wt',
					'Parsoid id found on element without a matching data-parsoid '
.						'entry: ID=' . $kv->v . '; ELT=' . $node->outerHTML
				);
			} else {
				$vInfo = $token->getAttributeShadowInfo( $k );
				if ( !$vInfo->modified && $vInfo->fromsrc ) {
					$out[] = $k . '=' . '"' . preg_replace( '/"/', '&quot;', $vInfo->value ) . '"';
				}
			}
			continue;
		}

		// Parsoid auto-generates ids for headings and they should
		// be stripped out, except if this is not auto-generated id.
		// Parsoid auto-generates ids for headings and they should
		// be stripped out, except if this is not auto-generated id.
		if ( $k === 'id' && preg_match( '/H[1-6]/', $node->nodeName ) ) {
			if ( DOMDataUtils::getDataParsoid( $node )->reusedId === true ) {
				$vInfo = $token->getAttributeShadowInfo( $k );
				$out[] = $k . '=' . '"' . preg_replace( '/"/', '&quot;', $vInfo->value ) . '"';
			}
			continue;
		}

		// Strip Parsoid-inserted class="mw-empty-elt" attributes
		// Strip Parsoid-inserted class="mw-empty-elt" attributes
		if ( $k === 'class' && Consts\Output\FlaggedEmptyElts::has( $node->nodeName ) ) {
			$kv->v = preg_replace( '/\bmw-empty-elt\b/', '', $kv->v, 1 );
			if ( !$kv->v ) {
				continue;
			}
		}

		// Strip other Parsoid-generated values
		//
		// FIXME: Given that we are currently escaping about/typeof keys
		// that show up in wikitext, we could unconditionally strip these
		// away right now.
		// Strip other Parsoid-generated values
		//
		// FIXME: Given that we are currently escaping about/typeof keys
		// that show up in wikitext, we could unconditionally strip these
		// away right now.
		$parsoidValueRegExp = PARSOID_ATTRIBUTES::get( $k );
		if ( $parsoidValueRegExp && preg_match( $parsoidValueRegExp, $kv->v ) ) {
			$v = str_replace( $parsoidValueRegExp, '', $kv->v );
			if ( $v ) {
				$out[] = $k . '=' . '"' . $v . '"';
			}
			continue;
		}

		if ( count( $k ) > 0 ) {
			$vInfo = $token->getAttributeShadowInfo( $k );
			$v = $vInfo->value;
			// Deal with k/v's that were template-generated
			// Deal with k/v's that were template-generated
			$kk = /* await */ $this->getAttributeKey( $node, $k );
			// Pass in kv.k, not k since k can potentially
			// be original wikitext source for 'k' rather than
			// the string value of the key.
			// Pass in kv.k, not k since k can potentially
			// be original wikitext source for 'k' rather than
			// the string value of the key.
			$vv = /* await */ $this->getAttributeValue( $node, $kv->k, $v );
			// Remove encapsulation from protected attributes
			// in pegTokenizer.pegjs:generic_newline_attribute
			// Remove encapsulation from protected attributes
			// in pegTokenizer.pegjs:generic_newline_attribute
			$kk = preg_replace( '/^data-x-/i', '', $kk, 1 );
			if ( count( $vv ) > 0 ) {
				if ( !$vInfo->fromsrc && !$isWt ) {
					// Escape wikitext entities
					$vv = preg_replace(
						'/>/', '&gt;', Util::escapeWtEntities( $vv ) )
					;
				}
				$out[] = $kk . '=' . '"' . preg_replace( '/"/', '&quot;', $vv ) . '"';
			} elseif ( preg_match( '/[{<]/', $kk ) ) {
				// Templated, <*include*>, or <ext-tag> generated
				$out[] = $kk;
			} else {
				$out[] = $kk . '=""';
			}
			continue;
		} elseif ( count( $kv->v ) ) {
			// not very likely..
			$out[] = $kv->v;
		}
	}

	// SSS FIXME: It can be reasonably argued that we can permanently delete
	// dangerous and unacceptable attributes in the interest of safety/security
	// and the resultant dirty diffs should be acceptable.  But, this is
	// something to do in the future once we have passed the initial tests
	// of parsoid acceptance.
	//
	// 'a' data attribs -- look for attributes that were removed
	// as part of sanitization and add them back
	// SSS FIXME: It can be reasonably argued that we can permanently delete
	// dangerous and unacceptable attributes in the interest of safety/security
	// and the resultant dirty diffs should be acceptable.  But, this is
	// something to do in the future once we have passed the initial tests
	// of parsoid acceptance.
	//
	// 'a' data attribs -- look for attributes that were removed
	// as part of sanitization and add them back
	$dataAttribs = $token->dataAttribs;
	if ( $dataAttribs->a && $dataAttribs->sa ) {
		$aKeys = Object::keys( $dataAttribs->a );
		foreach ( $aKeys as $k => $___ ) {
			// Attrib not present -- sanitized away!
			if ( !KV::lookupKV( $attribs, $k ) ) {
				$v = $dataAttribs->sa[ $k ];
				if ( $v ) {
					$out[] = $k . '=' . '"' . preg_replace( '/"/', '&quot;', $v ) . '"';
				} else {
					// at least preserve the key
					$out[] = $k;
				}
			}
		}
	}
	// XXX: round-trip optional whitespace / line breaks etc
	// XXX: round-trip optional whitespace / line breaks etc
	return implode( ' ', $out );
}


























































































































;

WikitextSerializer::prototype::_handleLIHackIfApplicable = function ( $node ) use ( &$DOMDataUtils, &$DOMUtils, &$undefined ) {
	$liHackSrc = DOMDataUtils::getDataParsoid( $node )->liHackSrc;
	$prev = DOMUtils::previousNonSepSibling( $node );

	// If we are dealing with an LI hack, then we must ensure that
	// we are dealing with either
	//
	//   1. A node with no previous sibling inside of a list.
	//
	//   2. A node whose previous sibling is a list element.
	if ( $liHackSrc !== null
&&			( ( $prev === null && DOMUtils::isList( $node->parentNode ) ) || // Case 1
				( $prev !== null && DOMUtils::isListItem( $prev ) ) )
	) { // Case 2
		$this->state->emitChunk( $liHackSrc, $node );
	}
};

function formatStringSubst( $format, $value, $forceTrim ) {
	if ( $forceTrim ) { $value = trim( $value );  }
	return preg_replace( '/_+/', function ( $hole ) {
			if ( $value === '' || count( $hole ) <= count( $value ) ) { return $value;  }
			return $value + ( ' '->repeat( count( $hole ) - count( $value ) ) );
		}, $format, 1 )


	;
}

function createParamComparator( $dpArgInfo, $tplData, $dataMwKeys ) {
	// Record order of parameters in new data-mw
	$newOrder = new Map( array_map( Array::from( $dataMwKeys ),
			function ( $key, $i ) {return  [ $key, [ 'order' => $i ] ]; }
		)

	);
	// Record order of parameters in templatedata (if present)
	$tplDataOrder = new Map();
	$aliasMap = new Map();
	$keys = [];
	if ( $tplData && is_array( $tplData->paramOrder ) ) {
		$params = $tplData->params;
		$tplData->paramOrder->forEach( function ( $k, $i ) use ( &$tplDataOrder, &$aliasMap, &$keys, &$params ) {
				$tplDataOrder->set( $k, [ 'order' => $i ] );
				$aliasMap->set( $k, [ 'key' => $k, 'order' => -1 ] );
				$keys[] = $k;
				// Aliases have the same sort order as the main name.
				$aliases = $params && $params[ $k ] && $params[ $k ]->aliases;
				( $aliases || [] )->forEach( function ( $a, $j ) use ( &$aliasMap, &$k ) {
						$aliasMap->set( $a, [ 'key' => $k, 'order' => $j ] );
					}
				);
			}
		);
	}
	// Record order of parameters in original wikitext (from data-parsoid)
	$origOrder = new Map( array_map( $dpArgInfo,
			function ( $argInfo, $i ) {return  [ $argInfo->k, [ 'order' => $i, 'dist' => 0 ] ]; }
		)

	);
	// Canonical parameter key gets the same order as an alias parameter
	// found in the original wikitext.
	$dpArgInfo->forEach( function ( $argInfo, $i ) use ( &$aliasMap, &$origOrder ) {
			$canon = $aliasMap->get( $argInfo->k );
			if ( $canon && !$origOrder->has( $canon->key ) ) {
				$origOrder->set( $canon->key, $origOrder->get( $argInfo->k ) );
			}
		}
	);
	// Find the closest "original parameter" for each templatedata parameter,
	// so that newly-added parameters are placed near the parameters which
	// templatedata says they should be adjacent to.
	$nearestOrder = new Map( $origOrder );
	$reduceF = function ( $acc, $val, $i ) use ( &$origOrder, &$nearestOrder ) {
		if ( $origOrder->has( $val ) ) {
			$acc = $origOrder->get( $val );
		}
		if ( !( $nearestOrder->has( $val ) && $nearestOrder->get( $val )->dist < $acc->dist ) ) {
			$nearestOrder->set( $val, $acc );
		}
		return [ 'order' => $acc->order, 'dist' => $acc->dist + 1 ];
	};
	// Find closest original parameter before the key.
	array_reduce( $keys, $reduceF, [ 'order' => -1, 'dist' => 2 * count( $keys ) ] );
	// Find closest original parameter after the key.
	$keys->reduceRight( $reduceF, [ 'order' => $origOrder->size, 'dist' => count( $keys ) ] );

	// Helper function to return a large number if the given key isn't
	// in the sort order map
	$big = max( $nearestOrder->size, $newOrder->size );
	$defaultGet = function ( $map, $key1, $key2 ) use ( &$big ) {
		$key = ( ( !$key2 ) || $map->has( $key1 ) ) ? $key1 : $key2;
		return ( $map->has( $key ) ) ? $map->get( $key )->order : $big;
	};

	return function /* cmp */( $a, $b ) use ( &$aliasMap, &$defaultGet, &$nearestOrder, &$tplDataOrder, &$newOrder ) {
		$acanon = $aliasMap->get( $a ) || [ 'key' => $a, 'order' => -1 ];
		$bcanon = $aliasMap->get( $b ) || [ 'key' => $b, 'order' => -1 ];
		// primary key is `nearestOrder` (nearest original parameter)
		$aOrder = $defaultGet( $nearestOrder, $a, $acanon->key );
		$bOrder = $defaultGet( $nearestOrder, $b, $bcanon->key );
		if ( $aOrder !== $bOrder ) { return $aOrder - $bOrder;  }
		// secondary key is templatedata order
		if ( $acanon->key === $bcanon->key ) { return $acanon->order - $bcanon->order;  }
		$aOrder = $defaultGet( $tplDataOrder, $acanon->key );
		$bOrder = $defaultGet( $tplDataOrder, $bcanon->key );
		if ( $aOrder !== $bOrder ) { return $aOrder - $bOrder;  }
		// tertiary key is original input order (makes sort stable)
		$aOrder = $defaultGet( $newOrder, $a );
		$bOrder = $defaultGet( $newOrder, $b );
		return $aOrder - $bOrder;
	};
}

// See https://github.com/wikimedia/mediawiki-extensions-TemplateData/blob/master/Specification.md
// for the templatedata specification.
WikitextSerializer::prototype::serializePart = /* async */function ( $state, $buf, $node, $type, $part, $tplData, $prevPart, $nextPart ) use ( &$FORMATSTRING_REGEXP, &$WTUtils, &$DOMDataUtils, &$undefined, &$TRAILING_COMMENT_OR_WS_AFTER_NL_REGEXP, &$DOMUtils ) {
	// Parse custom format specification, if present.
	$defaultBlockSpc = "{{_\n| _ = _\n}}"; // "block"
	// "block"
	$defaultInlineSpc = '{{_|_=_}}'; // "inline"
	// FIXME: Do a full regexp test maybe?
	// "inline"
	// FIXME: Do a full regexp test maybe?
	if ( preg_match( '/.*data-parsoid\/0.0.1"$/', $this->env->dpContentType ) ) {
		// For previous versions of data-parsoid,
		// wt2html pipeline used "|foo = bar" style args
		// as the default.
		$defaultInlineSpc = '{{_|_ = _}}';
	}

	$format = ( $tplData && $tplData->format ) ? strtolower( $tplData->format ) : null;
	if ( $format === 'block' ) { $format = $defaultBlockSpc;  }
	if ( $format === 'inline' ) { $format = $defaultInlineSpc;  }
	// Check format string for validity.
	// Check format string for validity.
	$parsedFormat = FORMATSTRING_REGEXP::exec( $format );
	if ( !$parsedFormat ) {
		$parsedFormat = FORMATSTRING_REGEXP::exec( $defaultInlineSpc );
		$format = null; // Indicates that no valid custom format was present.
	}// Indicates that no valid custom format was present.

	$formatSOL = $parsedFormat[ 1 ];
	$formatStart = $parsedFormat[ 2 ];
	$formatParamName = $parsedFormat[ 3 ];
	$formatParamValue = $parsedFormat[ 4 ];
	$formatEnd = $parsedFormat[ 5 ];
	$formatEOL = $parsedFormat[ 6 ];
	$forceTrim = ( $format !== null ) || WTUtils::isNewElt( $node );

	// Shoehorn formatting of top-level templatearg wikitext into this code.
	// Shoehorn formatting of top-level templatearg wikitext into this code.
	if ( $type === 'templatearg' ) {
		$formatStart = preg_replace( '/{{/', '{{{', $formatStart, 1 );
		$formatEnd = preg_replace( '/}}/', '}}}', $formatEnd, 1 );
	}

	// handle SOL newline requirement
	// handle SOL newline requirement
	if ( $formatSOL && !preg_match( '/\n$/', ( $prevPart !== null ) ? $buf : $state->sep->src ) ) {
		$buf += "\n";
	}

	// open the transclusion
	// open the transclusion
	$buf += formatStringSubst( $formatStart, $part->target->wt, $forceTrim );

	// Trim whitespace from data-mw keys to deal with non-compliant
	// clients. Make sure param info is accessible for the stripped key
	// since later code will be using the stripped key always.
	// Trim whitespace from data-mw keys to deal with non-compliant
	// clients. Make sure param info is accessible for the stripped key
	// since later code will be using the stripped key always.
	$tplKeysFromDataMw = array_map( Object::keys( $part->params ), function ( $k ) {
			$strippedK = trim( $k );
			if ( $k !== $strippedK ) {
				$part->params[ $strippedK ] = $part->params[ $k ];
			}
			return $strippedK;
		}
	)





	;
	if ( !count( $tplKeysFromDataMw ) ) {
		return $buf + $formatEnd;
	}

	$env = $this->env;

	// Per-parameter info from data-parsoid for pre-existing parameters
	// Per-parameter info from data-parsoid for pre-existing parameters
	$dp = DOMDataUtils::getDataParsoid( $node );
	$dpArgInfo = ( $dp->pi && $part->i !== null ) ? $dp->pi[ $part->i ] || [] : [];

	// Build a key -> arg info map
	// Build a key -> arg info map
	$dpArgInfoMap = new Map();
	$dpArgInfo->forEach(
		function ( $argInfo ) use ( &$dpArgInfoMap ) {return  $dpArgInfoMap->set( $argInfo->k, $argInfo ); }
	);

	// 1. Process all parameters and build a map of
	//    arg-name -> [serializeAsNamed, name, value]
	//
	// 2. Serialize tpl args in required order
	//
	// 3. Format them according to formatParamName/formatParamValue
	// 1. Process all parameters and build a map of
	//    arg-name -> [serializeAsNamed, name, value]
	//
	// 2. Serialize tpl args in required order
	//
	// 3. Format them according to formatParamName/formatParamValue

	$kvMap = new Map();
	foreach ( $tplKeysFromDataMw as $k => $___ ) {
		$param = $part->params[ $k ];
		$argInfo = $dpArgInfoMap->get( $k );
		if ( !$argInfo ) {
			$argInfo = [];
		}

		// TODO: Other formats?
		// Only consider the html parameter if the wikitext one
		// isn't present at all. If it's present but empty,
		// that's still considered a valid parameter.
		// TODO: Other formats?
		// Only consider the html parameter if the wikitext one
		// isn't present at all. If it's present but empty,
		// that's still considered a valid parameter.
		$value = null;
		if ( $param->wt !== null ) {
			$value = $param->wt;
		} else {
			$value = /* await */ $this->serializeHTML( [ 'env' => $env ], $param->html );
		}

		Assert::invariant( gettype( $value ) === 'string',
			'For param: ' . $k
.				', wt property should be a string but got: ' . $value
		);

		$serializeAsNamed = $argInfo->named || false;

		// The name is usually equal to the parameter key, but
		// if there's a key.wt attribute, use that.
		// The name is usually equal to the parameter key, but
		// if there's a key.wt attribute, use that.
		$name = null;
		if ( $param->key && $param->key->wt !== null ) {
			$name = $param->key->wt;
			// And make it appear even if there wasn't
			// data-parsoid information.
			// And make it appear even if there wasn't
			// data-parsoid information.
			$serializeAsNamed = true;
		} else {
			$name = $k;
		}

		// Use 'k' as the key, not 'name'.
		//
		// The normalized form of 'k' is used as the key in both
		// data-parsoid and data-mw. The full non-normalized form
		// is present in 'param.key.wt'
		// Use 'k' as the key, not 'name'.
		//
		// The normalized form of 'k' is used as the key in both
		// data-parsoid and data-mw. The full non-normalized form
		// is present in 'param.key.wt'
		$kvMap->set( $k, [ 'serializeAsNamed' => $serializeAsNamed, 'name' => $name, 'value' => $value ] );
	}

	$argOrder = Array::from( $kvMap->keys() )->
	sort( createParamComparator( $dpArgInfo, $tplData, $kvMap->keys() ) );

	$argIndex = 1;
	$numericIndex = 1;

	$numPositionalArgs = array_reduce( $dpArgInfo, function ( $n, $pi ) {
			return ( $part->params[ $pi->k ] !== null && !$pi->named ) ? $n + 1 : $n;
		}, 0
	)

	;

	$argBuf = [];
	foreach ( $argOrder as $param => $___ ) {
		$kv = $kvMap->get( $param );
		// Add nowiki escapes for the arg value, as required
		// Add nowiki escapes for the arg value, as required
		$escapedValue = $this->wteHandlers->escapeTplArgWT( $kv->value, [
				'serializeAsNamed' => $kv->serializeAsNamed || $param !== $numericIndex->toString(),
				'type' => $type,
				'argPositionalIndex' => $numericIndex,
				'numPositionalArgs' => $numPositionalArgs,
				'argIndex' => $argIndex++,
				'numArgs' => count( $tplKeysFromDataMw )
			]
		);
		if ( $escapedValue->serializeAsNamed ) {
			// WS trimming for values of named args
			$argBuf[] = [ 'dpKey' => $param, 'name' => $kv->name, 'value' => trim( $escapedValue->v ) ];
		} else {
			$numericIndex++;
			// No WS trimming for positional args
			// No WS trimming for positional args
			$argBuf[] = [ 'dpKey' => $param, 'name' => null, 'value' => $escapedValue->v ];
		}
	}

	// If no explicit format is provided, default format is:
	// - 'inline' for new args
	// - whatever format is available from data-parsoid for old args
	// (aka, overriding formatParamName/formatParamValue)
	//
	// If an unedited node OR if paramFormat is unspecified,
	// this strategy prevents unnecessary normalization
	// of edited transclusions which don't have valid
	// templatedata formatting information.

	// "magic case": If the format string ends with a newline, an extra newline is added
	// between the template name and the first parameter.
	// If no explicit format is provided, default format is:
	// - 'inline' for new args
	// - whatever format is available from data-parsoid for old args
	// (aka, overriding formatParamName/formatParamValue)
	//
	// If an unedited node OR if paramFormat is unspecified,
	// this strategy prevents unnecessary normalization
	// of edited transclusions which don't have valid
	// templatedata formatting information.

	// "magic case": If the format string ends with a newline, an extra newline is added
	// between the template name and the first parameter.
	$modFormatParamName = null; $modFormatParamValue = null;

	foreach ( $argBuf as $arg => $___ ) {
		$name = $arg->name;
		$val = $arg->value;
		if ( $name === null ) {
			// We are serializing a positional parameter.
			// Whitespace is significant for these and
			// formatting would change semantics.
			$name = '';
			$modFormatParamName = '|_';
			$modFormatParamValue = '_';
		} elseif ( $name === '' ) {
			// No spacing for blank parameters ({{foo|=bar}})
			// This should be an edge case and probably only for
			// inline-formatted templates, but we are consciously
			// forcing this default here. Can revisit if this is
			// ever a problem.
			$modFormatParamName = '|_=';
			$modFormatParamValue = '_';
		} else {
			// Preserve existing spacing, esp if there was a comment
			// embedded in it. Otherwise, follow TemplateData's lead.
			// NOTE: In either case, we are forcibly normalizing
			// non-block-formatted transclusions into block formats
			// by adding missing newlines.
			$spc = ( $dpArgInfoMap->get( $arg->dpKey ) || [] )->spc;
			if ( $spc && ( !$format || preg_match( Util\COMMENT_REGEXP, $spc[ 3 ] ) ) ) {
				$nl = ( $formatParamName->startsWith( "\n" ) ) ? "\n" : '';
				$modFormatParamName = $nl . '|' . $spc[ 0 ] . '_' . $spc[ 1 ] . '=' . $spc[ 2 ];
				$modFormatParamValue = '_' . $spc[ 3 ];
			} else {
				$modFormatParamName = $formatParamName;
				$modFormatParamValue = $formatParamValue;
			}
		}

		// Don't create duplicate newlines.
		// Don't create duplicate newlines.
		$trailing = preg_match( $TRAILING_COMMENT_OR_WS_AFTER_NL_REGEXP, $buf );
		if ( $trailing && $formatParamName->startsWith( "\n" ) ) {
			$modFormatParamName = array_slice( $formatParamName, 1 );
		}

		$buf += formatStringSubst( $modFormatParamName, $name, $forceTrim );
		$buf += formatStringSubst( $modFormatParamValue, $val, $forceTrim );
	}

	// Don't create duplicate newlines.
	// Don't create duplicate newlines.
	if ( preg_match( $TRAILING_COMMENT_OR_WS_AFTER_NL_REGEXP, $buf ) && $formatEnd->startsWith( "\n" ) ) {
		$buf += array_slice( $formatEnd, 1 );
	} else {
		$buf += $formatEnd;
	}

	if ( $formatEOL ) {
		if ( $nextPart === null ) {
			// This is the last part of the block. Add the \n only
			// if the next non-comment node is not a text node
			// of if the text node doesn't have a leading \n.
			$next = DOMUtils::nextNonDeletedSibling( $node );
			while ( $next && DOMUtils::isComment( $next ) ) {
				$next = DOMUtils::nextNonDeletedSibling( $next );
			}
			if ( !DOMUtils::isText( $next ) || !preg_match( '/^\n/', $next->nodeValue ) ) {
				$buf += "\n";
			}
		} elseif ( gettype( $nextPart ) !== 'string' || !preg_match( '/^\n/', $nextPart ) ) {
			// If nextPart is another template, and it wants a leading nl,
			// this \n we add here will count towards that because of the
			// formatSOL check at the top.
			$buf += "\n";
		}
	}

	return $buf;
}















































































































































































































































;

WikitextSerializer::prototype::serializeFromParts = /* async */function ( $state, $node, $srcParts ) use ( &$WTUtils, &$DiffUtils, &$TemplateDataRequest, &$Util ) {
	$env = $this->env;
	$useTplData = WTUtils::isNewElt( $node ) || DiffUtils::hasDiffMarkers( $node, $env );
	$buf = '';
	$numParts = count( $srcParts );
	for ( $i = 0;  $i < $numParts;  $i++ ) {
		$part = $srcParts[ $i ];
		$prevPart = ( $i > 0 ) ? $srcParts[ $i - 1 ] : null;
		$nextPart = ( $i < $numParts - 1 ) ? $srcParts[ $i + 1 ] : null;
		$tplarg = $part->templatearg;
		if ( $tplarg ) {
			$buf = /* await */ $this->serializePart( $state, $buf, $node, 'templatearg', $tplarg, null, $prevPart, $nextPart );
			continue;
		}

		$tpl = $part->template;
		if ( !$tpl ) {
			$buf += $part;
			continue;
		}

		// transclusion: tpl or parser function
		// transclusion: tpl or parser function
		$tplHref = $tpl->target->href;
		$isTpl = gettype( $tplHref ) === 'string';
		$type = ( $isTpl ) ? 'template' : 'parserfunction';

		// While the API supports fetching multiple template data objects in one call,
		// we will fetch one at a time to benefit from cached responses.
		//
		// Fetch template data for the template
		// While the API supports fetching multiple template data objects in one call,
		// we will fetch one at a time to benefit from cached responses.
		//
		// Fetch template data for the template
		$tplData = null;
		$fetched = false;
		try {
			$apiResp = null;
			if ( $isTpl && $useTplData ) {
				$href = preg_replace( '/^\.\//', '', $tplHref, 1 );
				$apiResp = /* await */ TemplateDataRequest::promise( $env, $href, Util::makeHash( [ 'templatedata', $href ] ) );
			}
			$tplData = $apiResp && $apiResp[ Object::keys( $apiResp )[ 0 ] ];
			// If the template doesn't exist, or does but has no TemplateData,
			// ignore it
			// If the template doesn't exist, or does but has no TemplateData,
			// ignore it
			if ( $tplData && ( $tplData->missing || $tplData->notemplatedata ) ) {
				$tplData = null;
			}
			$fetched = true;
			$buf = /* await */ $this->serializePart( $state, $buf, $node, $type, $tpl, $tplData, $prevPart, $nextPart );
		} catch ( Exception $err ) {
			if ( $fetched && $tplData === null ) {
				// Retrying won't help here.
				throw $err;
			} else {
				// No matter what error we encountered (fetching tpldata
				// or using it), log the error, and use default serialization mode.
				$env->log( 'error/html2wt/tpldata', $err );
				$buf = /* await */ $this->serializePart( $state, $buf, $node, $type, $tpl, null, $prevPart, $nextPart );
			}
		}
	}
	return $buf;
}


























































;

WikitextSerializer::prototype::serializeExtensionStartTag = /* async */function ( $node, $state ) use ( &$DOMDataUtils, &$TagTk ) {
	$dataMw = DOMDataUtils::getDataMw( $node );
	$extName = $dataMw->name;

	// Serialize extension attributes in normalized form as:
	// key='value'
	// FIXME: with no dataAttribs, shadow info will mark it as new
	// Serialize extension attributes in normalized form as:
	// key='value'
	// FIXME: with no dataAttribs, shadow info will mark it as new
	$attrs = $dataMw->attrs || [];
	$extTok = new TagTk( $extName, array_map( Object::keys( $attrs ), function ( $k ) {
				return new KV( $k, $attrs[ $k ] );
			}
		)

	);

	if ( $node->hasAttribute( 'about' ) ) {
		$extTok->addAttribute( 'about', $node->getAttribute( 'about' ) );
	}
	if ( $node->hasAttribute( 'typeof' ) ) {
		$extTok->addAttribute( 'typeof', $node->getAttribute( 'typeof' ) );
	}

	$attrStr = /* await */ $this->_serializeAttributes( $node, $extTok );
	$src = '<' . $extName;
	if ( $attrStr ) {
		$src += ' ' . $attrStr;
	}
	return $src + ( ( $dataMw->body ) ? '>' : ' />' );
}
























;

WikitextSerializer::prototype::defaultExtensionHandler = /* async */function ( $node, $state ) use ( &$DOMDataUtils ) {
	$dataMw = DOMDataUtils::getDataMw( $node );
	$src = /* await */ $this->serializeExtensionStartTag( $node, $state );
	if ( !$dataMw->body ) {
		return $src; // We self-closed this already.
	} else // We self-closed this already.
	if ( gettype( $dataMw->body->extsrc ) === 'string' ) {
		$src += $dataMw->body->extsrc;
	} else {
		$state->env->log( 'error/html2wt/ext', 'Extension src unavailable for: ' . $node->outerHTML );
	}
	return $src . '</' . $dataMw->name . '>';
}










;

/**
 * Get a `domHandler` for an element node.
 * @private
 */
WikitextSerializer::prototype::_getDOMHandler = function ( $node ) use ( &$DOMUtils, &$WTUtils, &$_getEncapsulatedContentHandler, &$DOMDataUtils, &$tagHandlers, &$htmlElementHandler, &$Consts ) {
	if ( !$node || !DOMUtils::isElt( $node ) ) { return [];  }

	if ( WTUtils::isFirstEncapsulationWrapperNode( $node ) ) {
		return _getEncapsulatedContentHandler::class();
	}

	$dp = DOMDataUtils::getDataParsoid( $node );
	$nodeName = strtolower( $node->nodeName );

	// If available, use a specialized handler for serializing
	// to the specialized syntactic form of the tag.
	$handler = tagHandlers::get( $nodeName . '_' . $dp->stx );

	// Unless a specialized handler is available, use the HTML handler
	// for html-stx tags. But, <a> tags should never serialize as HTML.
	if ( !$handler && $dp->stx === 'html' && $nodeName !== 'a' ) {
		return htmlElementHandler::class;
	}

	// If in a HTML table tag, serialize table tags in the table
	// using HTML tags, instead of native wikitext tags.
	if ( Consts\HTML\ChildTableTags::has( $node->nodeName )
&&			!Consts\ZeroWidthWikitextTags::has( $node->nodeName )
&&			WTUtils::inHTMLTableTag( $node )
	) {
		return htmlElementHandler::class;
	}

	// If parent node is a list in html-syntax, then serialize
	// list content in html-syntax rather than wiki-syntax.
	if ( DOMUtils::isListItem( $node )
&&			DOMUtils::isList( $node->parentNode )
&&			WTUtils::isLiteralHTMLNode( $node->parentNode )
	) {
		return htmlElementHandler::class;
	}

	// Pick the best available handler
	return $handler || tagHandlers::get( $nodeName ) || htmlElementHandler::class;
};

WikitextSerializer::prototype::separatorREs = [
	'pureSepRE' => /* RegExp */ '/^[ \t\r\n]*$/',
	'sepPrefixWithNlsRE' => /* RegExp */ '/^[ \t]*\n+[ \t\r\n]*/',
	'sepSuffixWithNlsRE' => /* RegExp */ '/\n[ \t\r\n]*$/'
];

/**
 * Consolidate separator handling when emitting text.
 * @private
 */
WikitextSerializer::prototype::_serializeText = function ( $res, $node, $omitEscaping ) use ( &$Util ) {
	$state = $this->state;

	// Deal with trailing separator-like text (at least 1 newline and other whitespace)
	$newSepMatch = preg_match( $this->separatorREs->sepSuffixWithNlsRE, $res );
	$res = str_replace( $this->separatorREs->sepSuffixWithNlsRE, '', $res );

	if ( !$state->inIndentPre ) {
		// Strip leading newlines and other whitespace
		$match = preg_match( $this->separatorREs->sepPrefixWithNlsRE, $res );
		if ( $match ) {
			$state->appendSep( $match[ 0 ] );
			$res = substr( $res, count( $match[ 0 ] ) );
		}
	}

	if ( $omitEscaping ) {
		$state->emitChunk( $res, $node );
	} else {
		// Always escape entities
		$res = Util::escapeWtEntities( $res );

		// If not in pre context, escape wikitext
		// XXX refactor: Handle this with escape handlers instead!
		$state->escapeText = ( $state->onSOL || !$state->currNodeUnmodified ) && !$state->inHTMLPre;
		$state->emitChunk( $res, $node );
		$state->escapeText = false;
	}

	// Move trailing newlines into the next separator
	if ( $newSepMatch ) {
		if ( !$state->sep->src ) {
			$state->appendSep( $newSepMatch[ 0 ] );
		} else {

			/* SSS FIXME: what are we doing with the stripped NLs?? */
		}
	}
};

/**
 * Serialize the content of a text node
 * @private
 */
WikitextSerializer::prototype::_serializeTextNode = Promise::method( function ( $node ) {
		$this->_serializeText( $node->nodeValue, $node, false );
	}
);

/**
 * Emit non-separator wikitext that does not need to be escaped.
 */
WikitextSerializer::prototype::emitWikitext = function ( $res, $node ) {
	$this->_serializeText( $res, $node, true );
};

WikitextSerializer::prototype::_getDOMAttribs = function ( $attribs ) use ( &$IGNORED_ATTRIBUTES ) {
	// convert to list of key-value pairs
	$out = [];
	for ( $i = 0,  $l = count( $attribs );  $i < $l;  $i++ ) {
		$attrib = $attribs->item( $i );
		if ( !IGNORED_ATTRIBUTES::has( $attrib->name ) ) {
			$out[] = [ 'k' => $attrib->name, 'v' => $attrib->value ];
		}
	}
	return $out;
};

// DOM-based serialization
WikitextSerializer::prototype::_serializeDOMNode = /* async */function ( $node, $domHandler ) use ( &$DOMDataUtils, &$WTSUtils, &$Util, &$DiffUtils, &$WTUtils, &$DOMUtils, &$ConstrainedText ) {
	// To serialize a node from source, the node should satisfy these
	// conditions:
	//
	// 1. It should not have a diff marker or be in a modified subtree
	//    WTS should not be in a subtree with a modification flag that
	//    applies to every node of a subtree (rather than an indication
	//    that some node in the subtree is modified).
	//
	// 2. It should continue to be valid in any surrounding edited context
	//    For some nodes, modification of surrounding context
	//    can change serialized output of this node
	//    (ex: <td>s and whether you emit | or || for them)
	//
	// 3. It should have valid, usable DSR
	//
	// 4. Either it has non-zero positive DSR width, or meets one of the
	//    following:
	//
	//    4a. It is content like <p><br/><p> or an automatically-inserted
	//        wikitext <references/> (HTML <ol>) (will have dsr-width 0)
	//    4b. it is fostered content (will have dsr-width 0)
	//    4c. it is misnested content (will have dsr-width 0)
	//
	// SSS FIXME: Additionally, we can guard against buggy DSR with
	// some sanity checks. We can test that non-sep src content
	// leading wikitext markup corresponds to the node type.
	//
	// Ex: If node.nodeName is 'UL', then src[0] should be '*'
	//
	// TO BE DONE

	$state = $this->state;
	$wrapperUnmodified = false;
	$dp = DOMDataUtils::getDataParsoid( $node );

	$dp->dsr = $dp->dsr || [];

	if ( $state->selserMode
&&			!$state->inModifiedContent
&&			WTSUtils::origSrcValidInEditedContext( $state->env, $node )
&&			$dp && Util::isValidDSR( $dp->dsr )
&&			( $dp->dsr[ 1 ] > $dp->dsr[ 0 ]
			// FIXME: <p><br/></p>
			// nodes that have dsr width 0 because currently,
			// we emit newlines outside the p-nodes. So, this check
			// tries to handle that scenario.
			 || // FIXME: <p><br/></p>
				// nodes that have dsr width 0 because currently,
				// we emit newlines outside the p-nodes. So, this check
				// tries to handle that scenario.
				( $dp->dsr[ 1 ] === $dp->dsr[ 0 ]
&&					( preg_match( '/^(P|BR)$/', $node->nodeName ) || DOMDataUtils::getDataMw( $node )->autoGenerated ) )
||				$dp->fostered || $dp->misnested )
	) {

		if ( !DiffUtils::hasDiffMarkers( $node, $this->env ) ) {
			// If this HTML node will disappear in wikitext because of
			// zero width, then the separator constraints will carry over
			// to the node's children.
			//
			// Since we dont recurse into 'node' in selser mode, we update the
			// separator constraintInfo to apply to 'node' and its first child.
			//
			// We could clear constraintInfo altogether which would be
			// correct (but could normalize separators and introduce dirty
			// diffs unnecessarily).

			$state->currNodeUnmodified = true;

			if ( WTUtils::isZeroWidthWikitextElt( $node )
&&					$node->hasChildNodes()
&&					$state->sep->constraints->constraintInfo->sepType === 'sibling'
			) {
				$state->sep->constraints->constraintInfo->onSOL = $state->onSOL;
				$state->sep->constraints->constraintInfo->sepType = 'parent-child';
				$state->sep->constraints->constraintInfo->nodeA = $node;
				$state->sep->constraints->constraintInfo->nodeB = $node->firstChild;
			}

			$out = $state->getOrigSrc( $dp->dsr[ 0 ], $dp->dsr[ 1 ] );

			$this->trace( 'ORIG-src with DSR',
				function () use ( &$dp ) {return  '[' . $dp->dsr[ 0 ] . ',' . $dp->dsr[ 1 ] . '] = ' . json_encode( $out ); }
			);

			// When reusing source, we should only suppress serializing
			// to a single line for the cases we've whitelisted in
			// normal serialization.
			// When reusing source, we should only suppress serializing
			// to a single line for the cases we've whitelisted in
			// normal serialization.
			$suppressSLC = WTUtils::isFirstEncapsulationWrapperNode( $node )
||				array_search( $node->nodeName, [ 'DL', 'UL', 'OL' ] ) > -1
||				( $node->nodeName === 'TABLE'
&&					$node->parentNode->nodeName === 'DD'
&&					DOMUtils::previousNonSepSibling( $node ) === null );

			// Use selser to serialize this text!  The original
			// wikitext is `out`.  But first allow
			// `ConstrainedText.fromSelSer` to figure out the right
			// type of ConstrainedText chunk(s) to use to represent
			// `out`, based on the node type.  Since we might actually
			// have to break this wikitext into multiple chunks,
			// `fromSelSer` returns an array.
			// Use selser to serialize this text!  The original
			// wikitext is `out`.  But first allow
			// `ConstrainedText.fromSelSer` to figure out the right
			// type of ConstrainedText chunk(s) to use to represent
			// `out`, based on the node type.  Since we might actually
			// have to break this wikitext into multiple chunks,
			// `fromSelSer` returns an array.
			if ( $suppressSLC ) { $state->singleLineContext->disable();  }
			ConstrainedText::fromSelSer( $out, $node, $dp, $state->env )->
			forEach( function ( $ct ) use ( &$state ) {return  $state->emitChunk( $ct, $ct->node ); } );
			if ( $suppressSLC ) { array_pop( $state->singleLineContext );  }

			// Skip over encapsulated content since it has already been
			// serialized.
			// Skip over encapsulated content since it has already been
			// serialized.
			if ( WTUtils::isFirstEncapsulationWrapperNode( $node ) ) {
				return WTUtils::skipOverEncapsulatedContent( $node );
			} else {
				return $node->nextSibling;
			}
		}

		if ( DiffUtils::onlySubtreeChanged( $node, $this->env )
&&				WTSUtils::hasValidTagWidths( $dp->dsr )
&&				// In general, we want to avoid nodes with auto-inserted
				// start/end tags since dsr for them might not be entirely
				// trustworthy. But, since wikitext does not have closing tags
				// for tr/td/th in the first place, dsr for them can be trusted.
				//
				// SSS FIXME: I think this is only for b/i tags for which we do
				// dsr fixups. It may be okay to use this for other tags.
				( ( !$dp->autoInsertedStart && !$dp->autoInsertedEnd )
||					preg_match( '/^(TD|TH|TR)$/', $node->nodeName ) )
		) {
			$wrapperUnmodified = true;
		}
	}

	$state->currNodeUnmodified = false;

	$currentModifiedState = $state->inModifiedContent;

	$inModifiedContent = $state->selserMode
&&		DiffUtils::hasInsertedDiffMark( $node, $this->env );

	if ( $inModifiedContent ) { $state->inModifiedContent = true;  }

	$next = /* await */ $domHandler->handle( $node, $state, $wrapperUnmodified );

	if ( $inModifiedContent ) { $state->inModifiedContent = $currentModifiedState;  }

	return $next;
}










































































































































;

/**
 * Internal worker. Recursively serialize a DOM subtree.
 * @private
 */
WikitextSerializer::prototype::_serializeNode = /* async */function ( $node ) use ( &$WTSUtils, &$DOMUtils, &$undefined ) {
	$prev = null; $domHandler = null; $method = null;
	$state = $this->state;

	if ( $state->selserMode ) {
		$this->trace( function () use ( &$WTSUtils, &$node ) {return  WTSUtils::traceNodeName( $node ); },
			'; prev-unmodified: ', $state->prevNodeUnmodified,
			'; SOL: ', $state->onSOL
		);
	} else {
		$this->trace( function () use ( &$WTSUtils, &$node ) {return  WTSUtils::traceNodeName( $node ); },
			'; SOL: ', $state->onSOL
		);
	}

	switch ( $node->nodeType ) {
		case $node::ELEMENT_NODE:
		// Ignore DiffMarker metas, but clear unmodified node state
		if ( DOMUtils::isDiffMarker( $node ) ) {
			$state->updateModificationFlags( $node );
			// `state.sep.lastSourceNode` is cleared here so that removed
			// separators between otherwise unmodified nodes don't get
			// restored.
			// `state.sep.lastSourceNode` is cleared here so that removed
			// separators between otherwise unmodified nodes don't get
			// restored.
			$state->updateSep( $node );
			return $node->nextSibling;
		}
		$domHandler = $this->_getDOMHandler( $node );
		Assert::invariant( $domHandler && $domHandler->handle,
			'No dom handler found for', $node->outerHTML
		);
		$method = $this->_serializeDOMNode;
		break;
		case $node::TEXT_NODE:
		// This code assumes that the DOM is in normalized form with no
		// run of text nodes.
		// Accumulate whitespace from the text node into state.sep.src
		$text = $node->nodeValue;
		if ( !$state->inIndentPre
&&				preg_match( $state->serializer->separatorREs->pureSepRE, $text )
		) {
			$state->appendSep( $text );
			return $node->nextSibling;
		}
		if ( $state->selserMode ) {
			$prev = $node->previousSibling;
			if ( !$state->inModifiedContent
&&					( !$prev && DOMUtils::isBody( $node->parentNode ) )
||						( $prev && !DOMUtils::isDiffMarker( $prev ) )
			) {
				$state->currNodeUnmodified = true;
			} else {
				$state->currNodeUnmodified = false;
			}
		}
		$domHandler = [];
		$method = $this->_serializeTextNode;
		break;
		case $node::COMMENT_NODE:
		// Merge this into separators
		$state->appendSep( WTSUtils::commentWT( $node->nodeValue ) );
		return $node->nextSibling;
		default:
		Assert::invariant( 'Unhandled node type:', $node->outerHTML );
	}

	$prev = DOMUtils::previousNonSepSibling( $node ) || $node->parentNode;
	$this->updateSeparatorConstraints(
		$prev, $this->_getDOMHandler( $prev ),
		$node, $domHandler
	);

	$nextNode = /* await */ call_user_func( 'method', $node, $domHandler );

	$next = DOMUtils::nextNonSepSibling( $node ) || $node->parentNode;
	$this->updateSeparatorConstraints(
		$node, $domHandler,
		$next, $this->_getDOMHandler( $next )
	);

	// Update modification flags
	// Update modification flags
	$state->updateModificationFlags( $node );

	// If handlers didn't provide a valid next node,
	// default to next sibling.
	// If handlers didn't provide a valid next node,
	// default to next sibling.
	if ( $nextNode === null ) {
		$nextNode = $node->nextSibling;
	}
	return $nextNode;
}

















































































;

WikitextSerializer::prototype::_stripUnnecessaryHeadingNowikis = function ( $line ) use ( &$COMMENT_OR_WS_REGEXP ) {
	$state = $this->state;
	if ( !$state->hasHeadingEscapes ) {
		return $line;
	}

	$escaper = function ( $wt ) use ( &$state ) {
		$ret = $state->serializer->wteHandlers->escapedText( $state, false, $wt, false, true );
		return $ret;
	};

	$match = preg_match( $HEADING_NOWIKI_REGEXP, $line );
	if ( $match && !preg_match( $COMMENT_OR_WS_REGEXP, $match[ 2 ] ) ) {
		// The nowiking was spurious since the trailing = is not in EOL position
		return $escaper( $match[ 1 ] ) + $match[ 2 ];
	} else {
		// All is good.
		return $line;
	}
};

WikitextSerializer::prototype::_stripUnnecessaryIndentPreNowikis = function () use ( &$Consts, &$TokenUtils ) {
	$env = $this->env;
	// FIXME: The solTransparentWikitextRegexp includes redirects, which really
	// only belong at the SOF and should be unique. See the "New redirect" test.
	$noWikiRegexp = new RegExp(
		'^' . $env->conf->wiki->solTransparentWikitextNoWsRegexp->source
.			"(<nowiki>\\s+</nowiki>)([^\n]*(?:\n|\$))", 'im'
	);
	$pieces = explode( $noWikiRegexp, $this->state->out );
	$out = $pieces[ 0 ];
	for ( $i = 1;  $i < count( $pieces );  $i += 4 ) {
		$out += $pieces[ $i ];
		$nowiki = $pieces[ $i + 1 ];
		$rest = $pieces[ $i + 2 ];
		// Ignore comments
		$htmlTags = preg_match_all( '/<[^!][^<>]*>/', $rest, $FIXME ) || [];

		// Not required if just sol transparent wt.
		$reqd = !preg_match( $env->conf->wiki->solTransparentWikitextRegexp, $rest );

		if ( $reqd ) {
			for ( $j = 0;  $j < count( $htmlTags );  $j++ ) {
				// Strip </, attributes, and > to get the tagname
				$tagName = strtoupper( preg_replace( '/<\/?|\s.*|>/', '', $htmlTags[ $j ] ) );
				if ( !Consts\HTML\HTML5Tags::has( $tagName ) ) {
					// If we encounter any tag that is not a html5 tag,
					// it could be an extension tag. We could do a more complex
					// regexp or tokenize the string to determine if any block tags
					// show up outside the extension tag. But, for now, we just
					// conservatively bail and leave the nowiki as is.
					$reqd = true;
					break;
				} elseif ( TokenUtils::isBlockTag( $tagName ) ) {
					// FIXME: Extension tags shadowing html5 tags might not
					// have block semantics.
					// Block tags on a line suppress nowikis
					$reqd = false;
				}
			}
		}

		if ( !$reqd ) {
			$nowiki = preg_replace( '/^<nowiki>(\s+)<\/nowiki>/', '$1', $nowiki, 1 );
		} elseif ( $env->scrubWikitext ) {
			$oldRest = null;
			$wsReplacementRE = new RegExp(
				'^(' . $env->conf->wiki->solTransparentWikitextNoWsRegexp->source . ')?\s+'
			);
			// Replace all leading whitespace
			do {
				$oldRest = $rest;
				$rest = str_replace( $wsReplacementRE, '$1', $rest );
			} while ( $rest !== $oldRest );

			// Protect against sol-sensitive wikitext characters
			$solCharsTest = new RegExp(
				'^' . $env->conf->wiki->solTransparentWikitextNoWsRegexp->source . '[=*#:;]'
			);
			$nowiki = preg_replace( '/^<nowiki>(\s+)<\/nowiki>/', ( preg_match( $solCharsTest, $rest ) ) ? '<nowiki/>' : '', $nowiki, 1 );
		}
		$out = $out + $nowiki + $rest + $pieces[ $i + 3 ];
	}
	$this->state->out = $out;
};

// This implements a heuristic to strip two common sources of <nowiki/>s.
// When <i> and <b> tags are matched up properly,
// - any single ' char before <i> or <b> does not need <nowiki/> protection.
// - any single ' char before </i> or </b> does not need <nowiki/> protection.
WikitextSerializer::prototype::_stripUnnecessaryQuoteNowikis = function ( $line ) use ( &$lastItem ) {
	if ( !$this->state->hasQuoteNowikis ) {
		return $line;
	}

	// Optimization: We are interested in <nowiki/>s before quote chars.
	// So, skip this if we don't have both.
	if ( !( preg_match( '/<nowiki\s*\/>/', $line ) && preg_match( "/'/", $line ) ) ) {
		return $line;
	}

	// * Split out all the [[ ]] {{ }} '' ''' ''''' <..> </...>
	//   parens in the regexp mean that the split segments will
	//   be spliced into the result array as the odd elements.
	// * If we match up the tags properly and we see opening
	//   <i> / <b> / <i><b> tags preceded by a '<nowiki/>, we
	//   can remove all those nowikis.
	//   Ex: '<nowiki/>''foo'' bar '<nowiki/>'''baz'''
	// * If we match up the tags properly and we see closing
	//   <i> / <b> / <i><b> tags preceded by a '<nowiki/>, we
	//   can remove all those nowikis.
	//   Ex: ''foo'<nowiki/>'' bar '''baz'<nowiki/>'''
	$p = preg_split( "/('''''|'''|''|\\[\\[|\\]\\]|\\{\\{|\\}\\}|<\\w+(?:\\s+[^>]*?|\\s*?)\\/?>|<\\/\\w+\\s*>)/", $line );

	// Which nowiki do we strip out?
	$nowikiIndex = -1;

	// Verify that everything else is properly paired up.
	$stack = [];
	$quotesOnStack = 0;
	$n = count( $p );
	$nonHtmlTag = null;
	for ( $j = 1;  $j < $n;  $j += 2 ) {
		// For HTML tags, pull out just the tag name for clearer code below.
		$tag = strtolower( ( /*RegExp#exec*/preg_match( '/^<(\/?\w+)/', $p[ $j ], $FIXME ) || '' )[ 1 ] || $p[ $j ] );
		$selfClose = false;
		if ( preg_match( '/\/>$/', $p[ $j ] ) ) { $tag += '/'; $selfClose = true;  }

		// Ignore non-html-tag (<nowiki> OR extension tag) blocks
		if ( !$nonHtmlTag ) {
			if ( $this->env->conf->wiki->extConfig->tags->has( $tag ) ) {
				$nonHtmlTag = $tag;
				continue;
			}
		} else {
			if ( $tag[ 0 ] === '/' && array_slice( $tag, 1 ) === $nonHtmlTag ) {
				$nonHtmlTag = null;
			}
			continue;
		}

		if ( $tag === ']]' ) {
			if ( array_pop( $stack ) !== '[[' ) { return $line;  }
		} elseif ( $tag === '}}' ) {
			if ( array_pop( $stack ) !== '{{' ) { return $line;  }
		} elseif ( $tag[ 0 ] === '/' ) { // closing html tag
			// match html/ext tags
			$opentag = array_pop( $stack );
			if ( $tag !== ( '/' . $opentag ) ) {
				return $line;
			}
		} elseif ( $tag === 'nowiki/' ) {
			// We only want to process:
			// - trailing single quotes (bar')
			// - or single quotes by themselves without a preceding '' sequence
			if ( preg_match( "/'\$/", $p[ $j - 1 ] ) && !( $p[ $j - 1 ] === "'" && preg_match( "/''\$/", $p[ $j - 2 ] ) )
&&					// Consider <b>foo<i>bar'</i>baz</b> or <b>foo'<i>bar'</i>baz</b>.
					// The <nowiki/> before the <i> or </i> cannot be stripped
					// if the <i> is embedded inside another quote.
					$quotesOnStack === 0
					// The only strippable scenario with a single quote elt on stack
					// is: ''bar'<nowiki/>''
					//   -> ["", "''", "bar'", "<nowiki/>", "", "''"]
					 || ( $quotesOnStack === 1
&&							$j + 2 < $n
&&							$p[ $j + 1 ] === ''
&&							$p[ $j + 2 ][ 0 ] === "'"
&&							$p[ $j + 2 ] === $lastItem( $stack ) )
			) {
				$nowikiIndex = $j;
			}
			continue;
		} elseif ( $selfClose || $tag === 'br' ) {
			// Skip over self-closing tags or what should have been self-closed.
			// ( While we could do this for all void tags defined in
			//   mediawiki.wikitext.constants.js, <br> is the most common
			//   culprit. )
			continue;
		} elseif ( $tag[ 0 ] === "'" && $lastItem( $stack ) === $tag ) {
			array_pop( $stack );
			$quotesOnStack--;
		} else {
			$stack[] = $tag;
			if ( $tag[ 0 ] === "'" ) { $quotesOnStack++;  }
		}
	}

	if ( count( $stack ) ) { return $line;  }

	if ( $nowikiIndex !== -1 ) {
		// We can only remove the final trailing nowiki.
		//
		// HTML  : <i>'foo'</i>
		// line  : ''<nowiki/>'foo'<nowiki/>''
		$p[ $nowikiIndex ] = '';
		return implode( '', $p );
	} else {
		return $line;
	}
};

/**
 * Serialize an HTML DOM document.
 * WARNING: You probably want to use {@link FromHTML.serializeDOM} instead.
 */
WikitextSerializer::prototype::serializeDOM = /* async */function ( $body, $selserMode ) use ( &$DOMUtils, &$ContentUtils, &$PHPDOMPass, &$DOMNormalizer ) {
	Assert::invariant( DOMUtils::isBody( $body ), 'Expected a body node.' );
	// `editedDoc` is simply body's ownerDocument.  However, since we make
	// recursive calls to WikitextSerializer.prototype.serializeDOM with elements from dom fragments
	// from data-mw, we need this to be set prior to the initial call.
	// It's mainly required for correct serialization of citations in some
	// scenarios (Ex: <ref> nested in <references>).
	// `editedDoc` is simply body's ownerDocument.  However, since we make
	// recursive calls to WikitextSerializer.prototype.serializeDOM with elements from dom fragments
	// from data-mw, we need this to be set prior to the initial call.
	// It's mainly required for correct serialization of citations in some
	// scenarios (Ex: <ref> nested in <references>).
	Assert::invariant( $this->env->page->editedDoc, 'Should be set.' );

	if ( !$selserMode ) {
		// Strip <section> tags
		// Selser mode will have done that already before running dom-diff
		ContentUtils::stripSectionTagsAndFallbackIds( $body );
	}

	$this->logType = ( $selserMode ) ? 'trace/selser' : 'trace/wts';
	$this->trace = function ( ...$args ) {return  $this->env->log( $this->logType, ...$args ); };

	$state = $this->state;
	$state->initMode( $selserMode );

	// Normalize the DOM
	// Normalize the DOM
	$pipelineConfig = $this->env->conf->parsoid->pipelineConfig;
	if ( $pipelineConfig && $pipelineConfig->html2wt && $pipelineConfig->html2wt->DOMNormalizer ) {
		if ( !$PHPDOMPass ) {
			$PHPDOMPass = require( '../../tests/porting/hybrid/PHPDOMPass.js' )::PHPDOMPass;
		}
		$body = ( new PHPDOMPass() )->normalizeDOM( $state, $body );
	} else {
		( new DOMNormalizer( $state ) )->normalize( $body );
	}

	$psd = $this->env->conf->parsoid;
	if ( $psd->dumpFlags && $psd->dumpFlags->has( 'dom:post-normal' ) ) {
		ContentUtils::dumpDOM( $body, 'DOM: post-normal', [ 'storeDiffMark' => true, 'env' => $this->env ] );
	}

	/* await */ $state->_kickOffSerialize( $body );

	if ( $state->hasIndentPreNowikis ) {
		// FIXME: Perhaps this can be done on a per-line basis
		// rather than do one post-pass on the entire document.
		//
		// Strip excess/useless nowikis
		$this->_stripUnnecessaryIndentPreNowikis();
	}

	$splitLines = $state->selserMode
||		$state->hasQuoteNowikis
||		$state->hasSelfClosingNowikis
||		$state->hasHeadingEscapes;

	if ( $splitLines ) {
		$state->out = implode(

















			"\n", array_map( explode( "\n", $state->out ), function ( $line ) {
					// Strip excess/useless nowikis
					//
					// FIXME: Perhaps this can be done on a per-line basis
					// rather than do one post-pass on the entire document.
					$line = $this->_stripUnnecessaryQuoteNowikis( $line );

					// Strip (useless) trailing <nowiki/>s
					// Interim fix till we stop introducing them in the first place.
					//
					// Don't strip |param = <nowiki/> since that pattern is used
					// in transclusions and where the trailing <nowiki /> is a valid
					// template arg. So, use a conservative regexp to detect that usage.
					// Strip (useless) trailing <nowiki/>s
					// Interim fix till we stop introducing them in the first place.
					//
					// Don't strip |param = <nowiki/> since that pattern is used
					// in transclusions and where the trailing <nowiki /> is a valid
					// template arg. So, use a conservative regexp to detect that usage.
					$line = preg_replace( '/^([^=]*?)(?:<nowiki\s*\/>\s*)+$/', '$1', $line, 1 );

					// Get rid of spurious heading nowiki escapes
					// Get rid of spurious heading nowiki escapes
					$line = $this->_stripUnnecessaryHeadingNowikis( $line );
					return $line;
				}
			)

















		);
	}

	if ( $state->redirectText && $state->redirectText !== 'unbuffered' ) {
		$firstLine = explode( "\n", 1, $state->out )[ 0 ];
		$nl = ( preg_match( '/^(\s|$)/', $firstLine ) ) ? '' : "\n";
		$state->out = $state->redirectText + $nl + $state->out;
	}

	return $state->out;
}
















































































;

if ( gettype( $module ) === 'object' ) {
	$module->exports->WikitextSerializer = $WikitextSerializer;
}
