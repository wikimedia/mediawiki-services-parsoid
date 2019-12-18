<?php
declare( strict_types = 1 );

/**
 * Front-end/Wrapper for a particular tree builder, in this case the
 * parser/tree builder from RemexHtml.  Feed it tokens  and it will build
 * you a DOM tree and emit an event.
 */

namespace Parsoid\Wt2Html;

use Generator;

use Parsoid\Config\Env;
use Parsoid\Tokens\CommentTk;
use Parsoid\Tokens\EndTagTk;
use Parsoid\Tokens\EOFTk;
use Parsoid\Tokens\KV;
use Parsoid\Tokens\NlTk;
use Parsoid\Tokens\SelfclosingTagTk;
use Parsoid\Tokens\TagTk;
use Parsoid\Tokens\Token;
use Parsoid\Utils\DataBag;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMTraverser;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\TokenUtils;
use Parsoid\Utils\Util;
use Parsoid\Utils\WTUtils;
use Parsoid\Wt2Html\PP\Handlers\PrepareDOM;

use RemexHtml\DOM\DOMBuilder;
use RemexHtml\Tokenizer\PlainAttributes;
use RemexHtml\Tokenizer\Tokenizer;
use RemexHtml\TreeBuilder\Dispatcher;
use RemexHtml\TreeBuilder\TreeBuilder;

use stdClass;
use Wikimedia\Assert\Assert;

class HTML5TreeBuilder extends PipelineStage {
	private $traceTime;

	/** @var int */
	private $tagId;

	/** @var bool */
	private $inTransclusion;

	/** @var DataBag */
	private $bag;

	/** @var int */
	private $tableDepth;

	/** @var DOMBuilder */
	private $domBuilder;

	/** @var Dispatcher */
	private $dispatcher;

	/** @var string|Token */
	private $lastToken;

	/** @var array<string|NlTk> */
	private $textContentBuffer;

	/**
	 * @param Env $env
	 * @param array $options
	 * @param int $stageId
	 * @param PipelineStage|null $prevStage
	 */
	public function __construct(
		Env $env, array $options = [], int $stageId = -1, $prevStage = null
	) {
		parent::__construct( $env, $prevStage );

		$this->traceTime = isset( $env->traceFlags['time'] );

		// Reset variable state and set up the parser
		$this->resetState( [] );
	}

	/**
	 * @inheritDoc
	 */
	public function resetState( array $options ): void {
		// Reset vars
		$this->tagId = 1; // Assigned to start/self-closing tags
		$this->inTransclusion = false;
		$this->bag = new DataBag();

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

		$this->domBuilder = new DOMBuilder( [ 'suppressHtmlNamespace' => true ] );
		$treeBuilder = new TreeBuilder( $this->domBuilder );
		$this->dispatcher = new Dispatcher( $treeBuilder );

		// PORT-FIXME: Necessary to setEnableCdataCallback
		$tokenizer = new Tokenizer( $this->dispatcher, '', [ 'ignoreErrors' => true ] );

		$this->dispatcher->startDocument( $tokenizer, null, null );
		$this->dispatcher->doctype( 'html', '', '', false, 0, 0 );
		$this->dispatcher->startTag( 'body', new PlainAttributes(), false, 0, 0 );

		// Remex does not seem to normalize text nodes as they are added to the DOM
		// - Will be fixed by https://gerrit.wikimedia.org/r/c/mediawiki/libs/RemexHtml/+/524831
		// So, we'll tackle it ourselves during tree building for now.
		$this->textContentBuffer = [];
	}

	/**
	 * Process a chunk of tokens and feed it to the HTML5 tree builder.
	 * This doesn't return anything.
	 *
	 * @param array $tokens Array of tokens to process
	 */
	public function processChunk( array $tokens ): void {
		$s = null;
		if ( $this->traceTime ) {
			$s = PHPUtils::getStartHRTime();
		}
		$n = count( $tokens );
		for ( $i = 0;  $i < $n;  $i++ ) {
			$this->processToken( $tokens[$i] );
		}
		if ( $this->traceTime ) {
			$this->env->bumpTimeUse( 'HTML5 TreeBuilder', PHPUtils::getHRTimeDifferential( $s ), 'HTML5' );
		}
	}

	/**
	 * @inheritDoc
	 */
	public function finalizeDOM() {
		// Check if the EOFTk actually made it all the way through, and flag the
		// page where it did not!
		if ( isset( $this->lastToken ) && !( $this->lastToken instanceof EOFTk ) ) {
			$this->env->log( 'error', 'EOFTk was lost in page', $this->env->getPageConfig()->getTitle() );
		}

		$doc = $this->domBuilder->getFragment();
		'@phan-var \DOMDocument $doc'; // @var \DOMDocument $doc

		// Special case where we can't call `env.createDocument()`
		$this->env->referenceDataObject( $doc, $this->bag );

		// Preparing the DOM is considered one "unit" with treebuilding,
		// so traversing is done here rather than during post-processing.
		//
		// Necessary when testing the port, since:
		// - de-duplicating data-object-ids must be done before we can store
		// data-attributes to cross language barriers;
		// - the calls to fosterCommentData below are storing data-object-ids,
		// which must be reinserted, again before storing ...
		$seenDataIds = [];
		$t = new DOMTraverser();
		$t->addHandler( null, function ( ...$args ) use ( &$seenDataIds ) {
			return PrepareDOM::handler( $seenDataIds, ...$args );
		}, true );
		$t->traverse( DOMCompat::getBody( $doc ), $this->env, [], false, null );

		// PORT-FIXME: Are we reusing this?  Switch to `init()`
		// $this->resetState([]);

		return $doc;
	}

	/**
	 * @param array $maybeAttribs
	 * @return array
	 */
	private function kvArrToAttr( array $maybeAttribs ): array {
		return array_reduce( $maybeAttribs, function ( $prev, $next ) {
			$prev[$next->k] = $next->v;
			return $prev;
		}, [] );
	}

	/**
	 * @param array $maybeAttribs
	 * @return array
	 */
	private function kvArrToFoster( array $maybeAttribs ): array {
		return array_map( function ( $attr ) {
			return [ $attr->k, $attr->v ];
		}, $maybeAttribs );
	}

	/**
	 * Keep this in sync with `DOMDataUtils.setNodeData()`
	 *
	 * @param array $attribs
	 * @param object $dataAttribs
	 * @return array
	 */
	public function stashDataAttribs( array $attribs, object $dataAttribs ): array {
		$data = [ 'parsoid' => $dataAttribs ];
		$attribs = array_filter( $attribs, function ( $attr ) use ( &$data ) {
				if ( $attr->k === 'data-mw' ) {
					Assert::invariant( !isset( $data['mw'] ), "data-mw already set." );
					$data['mw'] = json_decode( $attr->v );
					return false;
				}
				return true;
		} );
		$docId = $this->bag->stashObject( (object)$data );
		$attribs[] = new KV( DOMDataUtils::DATA_OBJECT_ATTR_NAME, (string)$docId );
		return $attribs;
	}

	private function processBufferedTextContent(): void {
		if ( count( $this->textContentBuffer ) === 0 ) {
			return;
		}

		$haveNonNlTk = false;
		$data = "";
		foreach ( $this->textContentBuffer as $t ) {
			if ( is_string( $t ) ) {
				$haveNonNlTk = true;
				$data .= $t;
			} else {
				$data .= "\n";
			}
		}

		$this->dispatcher->characters( $data, 0, strlen( $data ), 0, 0 );
		// NlTks are only fostered when accompanied by
		// non-whitespace. Safe to ignore.
		if ( $this->inTransclusion && $this->tableDepth > 0 && $haveNonNlTk ) {
			// If inside a table and a transclusion, add a meta tag
			// after every text node so that we can detect
			// fostered content that came from a transclusion.
			$this->env->log( 'debug/html', $this->pipelineId, 'Inserting shadow transclusion meta' );
			$this->dispatcher->startTag( 'meta', new PlainAttributes( $this->kvArrToAttr( [
				new KV( 'typeof', 'mw:TransclusionShadow' )
			] ) ), true, 0, 0 );
		}

		$this->textContentBuffer = [];
	}

	/**
	 * Adapt the token format to internal HTML tree builder format, call the actual
	 * html tree builder by emitting the token.
	 *
	 * @param Token|string $token
	 */
	public function processToken( $token ): void {
		if ( $this->pipelineId === 0 ) {
			$this->env->bumpWt2HtmlResourceUse( 'token' );
		}

		$attribs = $token->attribs ?? [];
		$dataAttribs = $token->dataAttribs ?? (object)[ 'tmp' => new stdClass ];

		if ( !isset( $dataAttribs->tmp ) ) {
			$dataAttribs->tmp = new stdClass;
		}

		if ( $this->inTransclusion ) {
			$dataAttribs->tmp->inTransclusion = true;
		}

		// Assign tagId to open/self-closing tags
		if ( $token instanceof TagTk || $token instanceof SelfclosingTagTk ) {
			$dataAttribs->tmp->tagId = $this->tagId++;
		}

		$attribs = $this->stashDataAttribs( $attribs, $dataAttribs );

		$this->env->log( 'trace/html', $this->pipelineId, function () use ( $token ) {
			return PHPUtils::jsonEncode( $token );
		} );

		// Store the last token
		$this->lastToken = $token;

		// Buffer strings & newlines and return
		if ( is_string( $token ) || $token instanceof NlTk ) {
			$this->textContentBuffer[] = $token;
			return;
		}

		/* Not a string or NlTk -- collapse them into a single text node */
		$this->processBufferedTextContent();

		if ( $token instanceof TagTk ) {
			$tName = $token->getName();
			if ( $tName === 'table' ) {
				$this->tableDepth++;
				// Don't add foster box in transclusion
				// Avoids unnecessary insertions, the case where a table
				// doesn't have tsr info, and the messy unbalanced table case,
				// like the navbox
				if ( !$this->inTransclusion ) {
					$this->env->log( 'debug/html', $this->pipelineId, 'Inserting foster box meta' );
					$this->dispatcher->startTag( 'table', new PlainAttributes( $this->kvArrToAttr( [
						new KV( 'typeof', 'mw:FosterBox' )
					] ) ), false, 0, 0 );
				}
			}
			$this->dispatcher->startTag(
				$tName, new PlainAttributes( $this->kvArrToAttr( $attribs ) ), false, 0, 0
			);
			if ( empty( $dataAttribs->autoInsertedStart ) ) {
				$this->env->log( 'debug/html', $this->pipelineId, 'Inserting shadow meta for', $tName );
				$attrs = $this->stashDataAttribs( [
					new KV( 'typeof', 'mw:StartTag' ),
					new KV( 'data-stag', "{$tName}:{$dataAttribs->tmp->tagId}" )
				], Util::clone( $dataAttribs ) );
				$this->dispatcher->comment(
					WTUtils::fosterCommentData( 'mw:shadow', $this->kvArrToFoster( $attrs ), false ),
					0, 0
				);
			}
		} elseif ( $token instanceof SelfclosingTagTk ) {
			$tName = $token->getName();

			// Re-expand an empty-line meta-token into its constituent comment + WS tokens
			if ( TokenUtils::isEmptyLineMetaToken( $token ) ) {
				$this->processChunk( $dataAttribs->tokens );
				return;
			}

			$wasInserted = false;

			// Convert mw metas to comments to avoid fostering.
			// But <*include*> metas, behavior switch metas
			// should be fostered since they end up generating
			// HTML content at the marker site.
			if ( $tName === 'meta' ) {
				$tTypeOf = $token->getAttribute( 'typeof' ) ?: '';
				$shouldFoster = preg_match(
					'/^mw:(Includes\/(OnlyInclude|IncludeOnly|NoInclude))\b/',
					$tTypeOf
				);
				if ( !$shouldFoster ) {
					$prop = $token->getAttribute( 'property' ) ?: '';
					$shouldFoster = preg_match( '/^(mw:PageProp\/[a-zA-Z]*)\b/', $prop );
				}
				if ( !$shouldFoster ) {
					// transclusions state
					if ( preg_match( '/^mw:Transclusion/', $tTypeOf ) ) {
						$this->inTransclusion = preg_match( '/^mw:Transclusion$/D', $tTypeOf );
					}
					$this->dispatcher->comment(
						WTUtils::fosterCommentData( $tTypeOf, $this->kvArrToFoster( $attribs ), false ),
						0, 0
					);
					$wasInserted = true;
				}
			}

			if ( !$wasInserted ) {
				$this->dispatcher->startTag(
					$tName, new PlainAttributes( $this->kvArrToAttr( $attribs ) ), true, 0, 0
				);
				if ( !Util::isVoidElement( $tName ) ) {
					// PORT-FIXME: startTag has a self-closed flag?
					// VOID_ELEMENTS are automagically treated as self-closing by
					// the tree builder
					$this->dispatcher->endTag( $tName, 0, 0 );
				}
			}
		} elseif ( $token instanceof EndTagTk ) {
			$tName = $token->getName();
			if ( $tName === 'table' && $this->tableDepth > 0 ) {
				$this->tableDepth--;
			}
			$this->dispatcher->endTag( $tName, 0, 0 );
			if ( empty( $dataAttribs->autoInsertedEnd ) ) {
				$this->env->log( 'debug/html', $this->pipelineId, 'Inserting shadow meta for', $tName );
				$attrs = array_merge(
					$attribs,
					[
						new KV( 'typeof', 'mw:EndTag' ),
						new KV( 'data-etag', $tName )
					]
				);
				$this->dispatcher->comment(
					WTUtils::fosterCommentData( 'mw:shadow', $this->kvArrToFoster( $attrs ), false ),
					0, 0
				);
			}
		} elseif ( $token instanceof CommentTk ) {
			$this->dispatcher->comment( $token->value, 0, 0 );
		} elseif ( $token instanceof EOFTk ) {
			$this->dispatcher->endDocument( 0 );
		} else {
			$errors = [
				'-------- Unhandled token ---------',
				'TYPE: ' . $token->getType(),
				'VAL : ' . PHPUtils::jsonEncode( $token )
			];
			$this->env->log( 'error', implode( "\n", $errors ) );
		}
	}

	/**
	 * @inheritDoc
	 */
	public function process( $input, array $opts = null ) {
		'@phan-var array $input'; // @var array $input
		$this->processChunk( $input );
		return $this->finalizeDOM();
	}

	/**
	 * @inheritDoc
	 */
	public function processChunkily( $input, array $opts = null ): Generator {
		if ( $this->prevStage ) {
			foreach ( $this->prevStage->processChunkily( $input, $opts ) as $chunk ) {
				'@phan-var array $chunk'; // @var array $chunk
				$this->processChunk( $chunk );
			}
			yield $this->finalizeDOM();
		} else {
			yield $this->process( $input, $opts );
		}
	}
}
