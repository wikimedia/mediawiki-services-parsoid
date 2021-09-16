<?php
declare( strict_types = 1 );

/**
 * Front-end/Wrapper for a particular tree builder, in this case the
 * parser/tree builder from RemexHtml.  Feed it tokens  and it will build
 * you a DOM tree and emit an event.
 */

namespace Wikimedia\Parsoid\Wt2Html;

use Generator;
use stdClass;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Tokens\CommentTk;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMTraverser;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\PP\Handlers\PrepareDOM;
use Wikimedia\RemexHtml\Tokenizer\PlainAttributes;
use Wikimedia\RemexHtml\TreeBuilder\Dispatcher;

class HTML5TreeBuilder extends PipelineStage {
	/** @var int */
	private $tagId;

	/** @var bool */
	private $inTransclusion;

	/** @var int */
	private $tableDepth;

	/** @var Document */
	private $doc;

	/** @var Dispatcher */
	private $dispatcher;

	/** @var string|Token */
	private $lastToken;

	/** @var array<string|NlTk> */
	private $textContentBuffer;

	/** @var bool */
	private $needTransclusionShadow;

	/**
	 * @param Env $env
	 * @param array $options
	 * @param string $stageId
	 * @param ?PipelineStage $prevStage
	 */
	public function __construct(
		Env $env, array $options = [], string $stageId = "",
		?PipelineStage $prevStage = null
	) {
		parent::__construct( $env, $prevStage );

		// Reset variable state and set up the parser
		$this->resetState( [] );
	}

	/**
	 * @inheritDoc
	 */
	public function resetState( array $options ): void {
		parent::resetState( $options );

		// Reset vars
		$this->tagId = 1; // Assigned to start/self-closing tags
		$this->inTransclusion = false;

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

		// We only need one for every run of strings and newline tokens.
		$this->needTransclusionShadow = false;

		list(
			$this->doc,
			$this->dispatcher,
		) = $this->env->fetchDocumentDispatcher( $this->atTopLevel );
	}

	/**
	 * Process a chunk of tokens and feed it to the HTML5 tree builder.
	 * This doesn't return anything.
	 *
	 * @param array $tokens Array of tokens to process
	 */
	public function processChunk( array $tokens ): void {
		$s = null;
		$profile = null;
		if ( $this->env->profiling() ) {
			$profile = $this->env->getCurrentProfile();
			$s = microtime( true );
		}
		$n = count( $tokens );
		for ( $i = 0;  $i < $n;  $i++ ) {
			$this->processToken( $tokens[$i] );
		}
		if ( $profile ) {
			$profile->bumpTimeUse(
				'HTML5 TreeBuilder', 1000 * ( microtime( true ) - $s ), 'HTML5' );
		}
	}

	/**
	 * @return Node
	 */
	public function finalizeDOM(): Node {
		// Check if the EOFTk actually made it all the way through, and flag the
		// page where it did not!
		if ( isset( $this->lastToken ) && !( $this->lastToken instanceof EOFTk ) ) {
			$this->env->log(
				'error', 'EOFTk was lost in page',
				$this->env->getPageConfig()->getTitle()
			);
		}

		if ( $this->atTopLevel ) {
			$node = DOMCompat::getBody( $this->doc );
		} else {
			// This is similar to DOMCompat::setInnerHTML() in that we can
			// consider it equivalent to the fragment parsing algorithm,
			// https://html.spec.whatwg.org/#html-fragment-parsing-algorithm
			$node = $this->env->topLevelDoc->createDocumentFragment();
			DOMUtils::migrateChildrenBetweenDocs(
				DOMCompat::getBody( $this->doc ), $node
			);
		}

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
		$t->addHandler( null, static function ( ...$args ) use ( &$seenDataIds ) {
			return PrepareDOM::handler( $seenDataIds, ...$args );
		} );
		$t->traverse( $this->env, $node, [], $this->atTopLevel, null );

		return $node;
	}

	/**
	 * @param array $kvArr
	 * @return array
	 */
	private function kvArrToAttr( array $kvArr ): array {
		$attribs = [];
		foreach ( $kvArr as $kv ) {
			$attribs[$kv->k] = $kv->v;

		}
		return $attribs;
	}

	/**
	 * Keep this in sync with `DOMDataUtils.setNodeData()`
	 *
	 * @param array $attribs
	 * @param object $dataAttribs
	 * @return array
	 */
	private function stashDataAttribs( array $attribs, object $dataAttribs ): array {
		$data = [ 'parsoid' => $dataAttribs ];
		if ( isset( $attribs['data-mw'] ) ) {
			// @phan-suppress-next-line PhanImpossibleCondition
			Assert::invariant( !isset( $data['mw'] ), "data-mw already set." );
			$data['mw'] = json_decode( $attribs['data-mw'] );
			unset( $attribs['data-mw'] );
		}
		// Store in the top level doc since we'll be importing the nodes after treebuilding
		$docId = DOMDataUtils::stashObjectInDoc( $this->env->topLevelDoc, (object)$data );
		$attribs[DOMDataUtils::DATA_OBJECT_ATTR_NAME] = (string)$docId;
		return $attribs;
	}

	/**
	 * Adapt the token format to internal HTML tree builder format, call the actual
	 * html tree builder by emitting the token.
	 *
	 * @param Token|string $token
	 */
	public function processToken( $token ): void {
		if ( $this->pipelineId === 0 ) {
			if ( $this->env->bumpWt2HtmlResourceUse( 'token' ) === false ) {
				// `false` indicates that this bump pushed us over the threshold
				// We don't want to log every token above that, which would be `null`
				$this->env->log( 'warn', "wt2html: token limit exceeded" );
			}
		}

		$attribs = isset( $token->attribs ) ? $this->kvArrToAttr( $token->attribs ) : [];
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

		$this->env->log( 'trace/html', $this->pipelineId, static function () use ( $token ) {
			return PHPUtils::jsonEncode( $token );
		} );

		// Store the last token
		$this->lastToken = $token;

		// If we encountered a non-string non-nl token, we have broken a run of
		// string+nl content.  If we need transclusion shadow protection, now's
		// the time to insert it.
		if (
			!is_string( $token ) && !( $token instanceof NlTk ) &&
			$this->needTransclusionShadow
		) {
			$this->needTransclusionShadow = false;
			// If inside a table and a transclusion, add a meta tag after every
			// text node so that we can detect fostered content that came from
			// a transclusion.
			$this->env->log( 'debug/html', $this->pipelineId, 'Inserting shadow transclusion meta' );
			$this->dispatcher->startTag( 'meta',
				new PlainAttributes( [ 'typeof' => 'mw:TransclusionShadow' ] ),
				true, 0, 0 );
		}

		if ( is_string( $token ) || $token instanceof NlTk ) {
			$data = $token instanceof NlTk ? "\n" : $token;
			$this->dispatcher->characters( $data, 0, strlen( $data ), 0, 0 );
			// NlTks are only fostered when accompanied by non-whitespace.
			// Safe to ignore.
			if (
				$this->inTransclusion && $this->tableDepth > 0 &&
				is_string( $token )
			) {
				$this->needTransclusionShadow = true;
			}
		} elseif ( $token instanceof TagTk ) {
			$tName = $token->getName();
			if ( $tName === 'table' ) {
				$this->tableDepth++;
				// Don't add foster box in transclusion
				// Avoids unnecessary insertions, the case where a table
				// doesn't have tsr info, and the messy unbalanced table case,
				// like the navbox
				if ( !$this->inTransclusion ) {
					$this->env->log( 'debug/html', $this->pipelineId, 'Inserting foster box meta' );
					$this->dispatcher->startTag( 'table',
						new PlainAttributes( [ 'typeof' => 'mw:FosterBox' ] ),
						false, 0, 0 );
				}
			}
			$this->dispatcher->startTag(
				$tName, new PlainAttributes( $attribs ), false, 0, 0
			);
			if ( empty( $dataAttribs->autoInsertedStart ) ) {
				$this->env->log( 'debug/html', $this->pipelineId, 'Inserting shadow meta for', $tName );
				$attrs = $this->stashDataAttribs( [
					'typeof' => 'mw:StartTag',
					'data-stag' => "{$tName}:{$dataAttribs->tmp->tagId}"
				], Utils::clone( $dataAttribs ) );
				$this->dispatcher->comment(
					WTUtils::fosterCommentData( 'mw:shadow', $attrs ),
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
				$shouldFoster = TokenUtils::matchTypeOf(
					$token,
					'#^mw:Includes/(OnlyInclude|IncludeOnly|NoInclude)(/|$)#'
				);
				if ( !$shouldFoster ) {
					$prop = $token->getAttribute( 'property' ) ?? '';
					$shouldFoster = preg_match( '/^(mw:PageProp\/[a-zA-Z]*)\b/', $prop );
				}
				if ( !$shouldFoster ) {
					// transclusions state
					$transType = TokenUtils::matchTypeOf( $token, '#^mw:Transclusion#' );
					if ( $transType ) {
						// typeof starts with mw:Transclusion
						$this->inTransclusion = ( $transType === 'mw:Transclusion' );
					}
					$this->dispatcher->comment(
						WTUtils::fosterCommentData(
							$token->getAttribute( 'typeof' ) ?? '',
							$attribs
						), 0, 0
					);
					$wasInserted = true;
				}
			}

			if ( !$wasInserted ) {
				$this->dispatcher->startTag(
					$tName, new PlainAttributes( $attribs ), false, 0, 0
				);
				if ( !Utils::isVoidElement( $tName ) ) {
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
				$attribs['typeof'] = 'mw:EndTag';
				$attribs['data-etag'] = $tName;
				$this->dispatcher->comment(
					WTUtils::fosterCommentData( 'mw:shadow', $attribs ),
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
		// @phan-suppress-next-line PhanTypeMismatchReturnSuperType
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
