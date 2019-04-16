<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Front-end/Wrapper for a particular tree builder, in this case the
 * parser/tree builder from the node
 * {@link https://www.npmjs.com/package/domino `domino`} module.
 * Feed it tokens using
 * {@link TreeBuilder#processToken}, and it will build you a DOM tree
 * and emit an event.
 * @module
 */

namespace Parsoid;

$HTMLParser = require 'domino'->impl->HTMLParser;
$TokenUtils = require '../utils/TokenUtils.js'::TokenUtils;
$WTUtils = require '../utils/WTUtils.js'::WTUtils;
$Util = require '../utils/Util.js'::Util;
$JSUtils = require '../utils/jsutils.js'::JSUtils;

$temp0 = require '../tokens/TokenTypes.js';
$TagTk = $temp0::TagTk;
$EndTagTk = $temp0::EndTagTk;
$SelfclosingTagTk = $temp0::SelfclosingTagTk;
$NlTk = $temp0::NlTk;
$EOFTk = $temp0::EOFTk;
$CommentTk = $temp0::CommentTk;
$temp1 = require '../utils/DOMDataUtils.js';
$DOMDataUtils = $temp1::DOMDataUtils;
$Bag = $temp1::Bag;
$temp2 = require '../utils/DOMTraverser.js';
$DOMTraverser = $temp2::DOMTraverser;
$temp3 = require './pp/handlers/PrepareDOM.js';
$PrepareDOM = $temp3::PrepareDOM;

/**
 * @class
 * @extends EventEmitter
 */
class TreeBuilder extends undefined {
	public function __construct( $env ) {
		parent::__construct();
		$this->env = $env;

		// Token types for the tree builder.
		$this->types = [
			'EOF' => -1,
			'TEXT' => 1,
			'TAG' => 2,
			'ENDTAG' => 3,
			'COMMENT' => 4,
			'DOCTYPE' => 5
		];

		$psd = $this->env->conf->parsoid;
		$this->traceTime = (bool)( $psd->traceFlags && $psd->traceFlags->has( 'time' ) );

		// Reset variable state and set up the parser
		$this->resetState();
	}
	public $env;

	public $types;

	public $traceTime;

	/**
	 * Register for (token) 'chunk' and 'end' events from a token emitter,
	 * normally the TokenTransformDispatcher.
	 */
	public function addListenersOn( $emitter ) {
		$emitter->addListener( 'chunk', function ( $tokens ) {return $this->onChunk( $tokens );
  } );
		$emitter->addListener( 'end', function () {return $this->onEnd();
  } );
	}

	/**
	 * Debugging aid: set pipeline id
	 */
	public function setPipelineId( $id ) {
		$this->pipelineId = $id;
	}

	public function resetState() {
		// Reset vars
		$this->tagId = 1; // Assigned to start/self-closing tags
		$this->inTransclusion = false;
		$this->bag = new Bag();

		/* --------------------------------------------------------------------
		 * Crude tracking of whether we are in a table
		 *
		 * The only requirement for correctness of detecting fostering content
		 * is that as long as there is an unclosed <table> tag, this value
		 * is positive.
		 *
		 * We can ensure that by making sure that independent of how many
		 * excess </table> tags we run into, this value is never negative.
		 *
		 * So, since this.tableDepth >= 0 always, whenever a <table> tag is seen,
		 * this.tableDepth >= 1 always, and our requirement is met.
		 * -------------------------------------------------------------------- */
		$this->tableDepth = 0;

		// Have we inserted a transclusion shadow meta already?
		// We only need one for every run of strings and newline tokens.
		$this->haveTransclusionShadow = false;

		$this->parser = new HTMLParser();
		$this->parser->insertToken( $this->types->DOCTYPE, 'html' );
		$this->parser->insertToken( $this->types->TAG, 'body' );
	}

	public function onChunk( $tokens ) {
		$s = null;
		if ( $this->traceTime ) { $s = JSUtils::startTime();
  }
		$n = count( $tokens );
		for ( $i = 0;  $i < $n;  $i++ ) {
			$this->processToken( $tokens[ $i ] );
		}
		if ( $this->traceTime ) {
			$this->env->bumpTimeUse( 'HTML5 TreeBuilder', JSUtils::elapsedTime( $s ), 'HTML5' );
		}
	}

	public function onEnd() {
		// Check if the EOFTk actually made it all the way through, and flag the
		// page where it did not!
		if ( $this->lastToken && $this->lastToken->constructor !== $EOFTk ) {
			$this->env->log( 'error', 'EOFTk was lost in page', $this->env->page->name );
		}

		// Special case where we can't call `env.createDocument()`
		$doc = $this->parser->document();
		$this->env->referenceDataObject( $doc, $this->bag );

		// Preparing the DOM is considered one "unit" with treebuilding,
		// so traversing is done here rather than during post-processing.
		//
		// Necessary when testing the port, since:
		// - de-duplicating data-object-ids must be done before we can store
		// data-attributes to cross language barriers;
		// - the calls to fosterCommentData below are storing data-object-ids,
		// which must be reinserted, again before storing ...
		$seenDataIds = new Set();
		$t = new DOMTraverser();
		$t->addHandler( null, function ( ...$args ) use ( &$PrepareDOM, &$seenDataIds ) {return PrepareDOM::prepareDOM( $seenDataIds, ...$args );
  } );
		$t->traverse( $doc->body, $this->env );

		$this->emit( 'document', $doc );

		$this->emit( 'end' );
		$this->resetState();
	}

	public function _att( $maybeAttribs ) {
		return array_map( $maybeAttribs, function ( $attr ) {return [ $attr->k, $attr->v ];
  } );
	}

	// Keep this in sync with `DOMDataUtils.setNodeData()`
	public function stashDataAttribs( $attribs, $dataAttribs ) {
		$data = [ 'parsoid' => $dataAttribs ];
		$attribs = $attribs->filter( function ( $attr ) use ( &$data ) {
				if ( $attr->k === 'data-mw' ) {
					Assert::invariant( $data->mw === null );
					$data->mw = json_decode( $attr->v );
					return false;
				}
				return true;
		}
		);
		$docId = $this->bag->stashObject( $data );
		$attribs[] = [ 'k' => DOMDataUtils\DataObjectAttrName(), 'v' => $docId ];
		return $attribs;
	}

	/**
	 * Adapt the token format to internal HTML tree builder format, call the actual
	 * html tree builder by emitting the token.
	 */
	public function processToken( $token ) {
		if ( $this->pipelineId === 0 ) {
			$this->env->bumpParserResourceUse( 'token' );
		}

		$attribs = $token->attribs || [];
		$dataAttribs = $token->dataAttribs || [ 'tmp' => [] ];

		if ( !$dataAttribs->tmp ) {
			$dataAttribs->tmp = [];
		}

		if ( $this->inTransclusion ) {
			$dataAttribs->tmp->inTransclusion = true;
		}

		// Assign tagId to open/self-closing tags
		if ( $token->constructor === $TagTk || $token->constructor === $SelfclosingTagTk ) {
			$dataAttribs->tmp->tagId = $this->tagId++;
		}

		$attribs = $this->stashDataAttribs( $attribs, $dataAttribs );

		$this->env->log( 'trace/html', $this->pipelineId, function () {
				return json_encode( $token );
		}
		);

		$tName = null;
$attrs = null;
$data = null;
		switch ( $token->constructor ) {
			case $String:

			case $NlTk:
			$data = ( $token->constructor === $NlTk ) ? "\n" : $token;
			$this->parser->insertToken( $this->types->TEXT, $data );
			// NlTks are only fostered when accompanied by
			// non-whitespace. Safe to ignore.
			if ( $this->inTransclusion && $this->tableDepth > 0
&& $token->constructor === $String && !$this->haveTransclusionShadow
			) {
				// If inside a table and a transclusion, add a meta tag
				// after every text node so that we can detect
				// fostered content that came from a transclusion.
				$this->env->log( 'debug/html', $this->pipelineId, 'Inserting shadow transclusion meta' );
				$this->parser->insertToken( $this->types->TAG, 'meta', [
						[ 'typeof', 'mw:TransclusionShadow' ]
					]
				);
				$this->haveTransclusionShadow = true;
			}
			break;
			case $TagTk:
			$tName = $token->name;
			if ( $tName === 'table' ) {
				$this->tableDepth++;
				// Don't add foster box in transclusion
				// Avoids unnecessary insertions, the case where a table
				// doesn't have tsr info, and the messy unbalanced table case,
				// like the navbox
				if ( !$this->inTransclusion ) {
					$this->env->log( 'debug/html', $this->pipelineId, 'Inserting foster box meta' );
					$this->parser->insertToken( $this->types->TAG, 'table', [
							[ 'typeof', 'mw:FosterBox' ]
						]
					);
				}
			}
			$this->parser->insertToken( $this->types->TAG, $tName, $this->_att( $attribs ) );
			if ( $dataAttribs && !$dataAttribs->autoInsertedStart ) {
				$this->env->log( 'debug/html', $this->pipelineId, 'Inserting shadow meta for', $tName );
				$attrs = [
					[ 'typeof', 'mw:StartTag' ],
					[ 'data-stag', "{$tName}:{$dataAttribs->tmp->tagId}" ]
				]->concat( $this->_att( $this->stashDataAttribs( [], Util::clone( $dataAttribs ) ) ) );
				$this->parser->insertToken(
					$this->types->COMMENT,
					WTUtils::fosterCommentData( 'mw:shadow', $attrs, false )
				);
			}
			break;
			case $SelfclosingTagTk:
			$tName = $token->name;

			// Re-expand an empty-line meta-token into its constituent comment + WS tokens
			if ( TokenUtils::isEmptyLineMetaToken( $token ) ) {
				$this->onChunk( $dataAttribs->tokens );
				break;
			}

			// Convert mw metas to comments to avoid fostering.
			// But <*include*> metas, behavior switch metas
			// should be fostered since they end up generating
			// HTML content at the marker site.
			if ( $tName === 'meta' ) {
				$tTypeOf = $token->getAttribute( 'typeof' );
				$shouldFoster = preg_match( ( '/^mw:(Includes\/(OnlyInclude|IncludeOnly|NoInclude))\b/' ), $tTypeOf );
				if ( !$shouldFoster ) {
					$prop = $token->getAttribute( 'property' );
					$shouldFoster = preg_match( ( '/^(mw:PageProp\/[a-zA-Z]*)\b/' ), $prop );
				}
				if ( !$shouldFoster ) {
					// transclusions state
					if ( preg_match( '/^mw:Transclusion/', $tTypeOf ) ) {
						$this->inTransclusion = preg_match( '/^mw:Transclusion$/', $tTypeOf );
					}
					$this->parser->insertToken(
						$this->types->COMMENT,
						WTUtils::fosterCommentData( $tTypeOf, $this->_att( $attribs ), false )
					);
					break;
				}
			}

			$newAttrs = $this->_att( $attribs );
			$this->parser->insertToken( $this->types->TAG, $tName, $newAttrs );
			if ( !Util::isVoidElement( $tName ) ) {
				// VOID_ELEMENTS are automagically treated as self-closing by
				// the tree builder
				$this->parser->insertToken( $this->types->ENDTAG, $tName, $newAttrs );
			}
			break;
			case $EndTagTk:
			$tName = $token->name;
			if ( $tName === 'table' && $this->tableDepth > 0 ) {
				$this->tableDepth--;
			}
			$this->parser->insertToken( $this->types->ENDTAG, $tName );
			if ( $dataAttribs && !$dataAttribs->autoInsertedEnd ) {
				$this->env->log( 'debug/html', $this->pipelineId, 'Inserting shadow meta for', $tName );
				$attrs = $this->_att( $attribs )->concat( [
						[ 'typeof', 'mw:EndTag' ],
						[ 'data-etag', $tName ]
					]
				);
				$this->parser->insertToken(
					$this->types->COMMENT,
					WTUtils::fosterCommentData( 'mw:shadow', $attrs, false )
				);
			}
			break;
			case $CommentTk:
			$this->parser->insertToken( $this->types->COMMENT, $token->value );
			break;
			case $EOFTk:
			$this->parser->insertToken( $this->types->EOF );
			break;
			default:
			$errors = [
				'-------- Unhandled token ---------',
				'TYPE: ' . $token->constructor->name,
				'VAL : ' . json_encode( $token )
			];
			$this->env->log( 'error', implode( "\n", $errors ) );
			break;
		}

		// If we encountered a non-string non-nl token, we have broken
		// a run of string+nl content and the next occurence of one of
		// those tokens will need transclusion shadow protection again.
		if ( $token->constructor !== $String && $token->constructor !== $NlTk ) {
			$this->haveTransclusionShadow = false;
		}

		// Store the last token
		$this->lastToken = $token;
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->TreeBuilder = $TreeBuilder;
}
