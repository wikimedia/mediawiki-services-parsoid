<?php
declare( strict_types = 1 );
// Suppress UnusedPluginSuppression because
// Phan on PHP 7.4 and PHP 8.1 need different suppressions
// @phan-file-suppress UnusedPluginSuppression,UnusedPluginFileSuppression

/**
 * Front-end/Wrapper for a particular tree builder, in this case the
 * parser/tree builder from RemexHtml.  Feed it tokens  and it will build
 * you a DOM tree and emit an event.
 */

namespace Wikimedia\Parsoid\Wt2Html\TreeBuilder;

use Generator;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\NodeData\NodeData;
use Wikimedia\Parsoid\NodeData\TempData;
use Wikimedia\Parsoid\Tokens\CommentTk;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\PipelineStage;

class TreeBuilderStage extends PipelineStage {
	/** @var int */
	private $tagId;

	/** @var bool */
	private $inTransclusion;

	/** @var int */
	private $tableDepth;

	/** @var RemexPipeline */
	private $remexPipeline;

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

		$this->remexPipeline = $this->env->fetchRemexPipeline( $this->atTopLevel );
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
			$node = DOMCompat::getBody( $this->remexPipeline->doc );
		} else {
			// This is similar to DOMCompat::setInnerHTML() in that we can
			// consider it equivalent to the fragment parsing algorithm,
			// https://html.spec.whatwg.org/#html-fragment-parsing-algorithm
			$node = $this->env->topLevelDoc->createDocumentFragment();
			DOMUtils::migrateChildrenBetweenDocs(
				DOMCompat::getBody( $this->remexPipeline->doc ), $node
			);
		}

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
	 * @param DataParsoid $dataAttribs
	 * @return array
	 */
	private function stashDataAttribs( array $attribs, DataParsoid $dataAttribs ): array {
		$data = new NodeData;
		$data->parsoid = $dataAttribs;
		if ( isset( $attribs['data-mw'] ) ) {
			$data->mw = json_decode( $attribs['data-mw'] );
			unset( $attribs['data-mw'] );
		}
		// Store in the top level doc since we'll be importing the nodes after treebuilding
		$docId = DOMDataUtils::stashObjectInDoc( $this->env->topLevelDoc, $data );
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

		$dispatcher = $this->remexPipeline->dispatcher;
		$attribs = isset( $token->attribs ) ? $this->kvArrToAttr( $token->attribs ) : [];
		$dataAttribs = $token->dataAttribs ?? new DataParsoid;
		$tmp = $dataAttribs->getTemp();

		if ( $this->inTransclusion ) {
			$tmp->setFlag( TempData::IN_TRANSCLUSION );
		}

		// Assign tagId to open/self-closing tags
		if ( $token instanceof TagTk || $token instanceof SelfclosingTagTk ) {
			$tmp->tagId = $this->tagId++;
		}

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
			$this->remexPipeline->insertExplicitStartTag( 'meta',
				[ 'typeof' => 'mw:TransclusionShadow' ],
				true );
		}

		if ( is_string( $token ) || $token instanceof NlTk ) {
			$data = $token instanceof NlTk ? "\n" : $token;
			$dispatcher->characters( $data, 0, strlen( $data ), 0, 0 );
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
					$this->remexPipeline->insertImplicitStartTag(
						'table',
						[ 'typeof' => 'mw:FosterBox' ]
					);
				}
			}

			$node = $this->remexPipeline->insertExplicitStartTag(
				$tName,
				$this->stashDataAttribs( $attribs, $dataAttribs ),
				false
			);
			if ( !$node ) {
				$this->handleDeletedStartTag( $tName, $dataAttribs );
			}
		} elseif ( $token instanceof SelfclosingTagTk ) {
			$tName = $token->getName();

			// Re-expand an empty-line meta-token into its constituent comment + WS tokens
			if ( TokenUtils::isEmptyLineMetaToken( $token ) ) {
				$this->processChunk( $dataAttribs->tokens );
				return;
			}

			$wasInserted = false;

			// FIXME: This prevents fostering of all metas except those
			// that are explictly identified for fostering. Instead,
			// this should foster all metas except those are explicitly
			// barred from being fostered.

			// <*include*> metas, behavior switch metas
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
					$this->remexPipeline->insertUnfosteredMeta(
						$this->stashDataAttribs( $attribs, $dataAttribs ) );
					$wasInserted = true;
				}
			}

			if ( !$wasInserted ) {
				$node = $this->remexPipeline->insertExplicitStartTag(
					$tName,
					$this->stashDataAttribs( $attribs, $dataAttribs ),
					false
				);
				if ( $node ) {
					if ( !Utils::isVoidElement( $tName ) ) {
						$this->remexPipeline->insertExplicitEndTag(
							$tName, ( $dataAttribs->stx ?? '' ) === 'html' );
					}
				} else {
					$this->insertPlaceholderMeta( $tName, $dataAttribs, true );
				}
			}
		} elseif ( $token instanceof EndTagTk ) {
			$tName = $token->getName();
			if ( $tName === 'table' && $this->tableDepth > 0 ) {
				$this->tableDepth--;
			}
			$node = $this->remexPipeline->insertExplicitEndTag(
				$tName,
				( $dataAttribs->stx ?? '' ) === 'html'
			);
			if ( $node ) {
				// Copy data attribs from the end tag to the element
				$nodeDP = DOMDataUtils::getDataParsoid( $node );
				if ( !WTUtils::hasLiteralHTMLMarker( $nodeDP )
					&& isset( $dataAttribs->endTagSrc )
				) {
					$nodeDP->endTagSrc = $dataAttribs->endTagSrc;
				}
				if ( !empty( $dataAttribs->stx ) ) {
					// FIXME: Not sure why we do this. For example,
					// with "{|\n|x\n</table>", why should the entire table
					// be marked HTML syntax? This is probably entirely
					// 2013-era historical stuff. Investigate & fix.
					//
					// Transfer stx flag
					$nodeDP->stx = $dataAttribs->stx;
				}
				if ( isset( $dataAttribs->tsr ) ) {
					$nodeDP->getTemp()->endTSR = $dataAttribs->tsr;
				}
				if ( isset( $nodeDP->autoInsertedStartToken ) ) {
					$nodeDP->autoInsertedStart = true;
					unset( $nodeDP->autoInsertedStartToken );
				}
				if ( isset( $nodeDP->autoInsertedEndToken ) ) {
					$nodeDP->autoInsertedEnd = true;
					unset( $nodeDP->autoInsertedEndToken );
				}
			} else {
				// The tag was stripped. Insert an mw:Placeholder for round-tripping
				$this->insertPlaceholderMeta( $tName, $dataAttribs, false );
			}
		} elseif ( $token instanceof CommentTk ) {
			$dispatcher->comment( $token->value, 0, 0 );
		} elseif ( $token instanceof EOFTk ) {
			$dispatcher->endDocument( 0 );
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
	 * Insert td/tr/th tag source or a placeholder meta
	 *
	 * @param string $name
	 * @param DataParsoid $dp
	 */
	private function handleDeletedStartTag( string $name, DataParsoid $dp ): void {
		if ( ( $dp->stx ?? null ) !== 'html' &&
			( $name === 'td' || $name === 'tr' || $name === 'th' )
		) {
			// A stripped wikitext-syntax table tag outside of a table. Re-insert the original
			// page source.
			if ( !empty( $dp->tsr ) &&
				$dp->tsr->start !== null && $dp->tsr->end !== null
			) {
				$origTxt = $dp->tsr->substr( $this->frame->getSrcText() );
			} else {
				switch ( $name ) {
					case 'td':
						$origTxt = '|';
						break;
					case 'tr':
						$origTxt = '|-';
						break;
					case 'th':
						$origTxt = '!';
						break;
					default:
						$origTxt = '';
						break;
				}
			}
			if ( $origTxt !== '' ) {
				$this->remexPipeline->dispatcher->characters( $origTxt, 0, strlen( $origTxt ), 0,
					0 );
			}
		} else {
			$this->insertPlaceholderMeta( $name, $dp, true );
		}
	}

	/**
	 * Insert a placeholder meta for a deleted start or end tag
	 *
	 * @param string $name
	 * @param DataParsoid $dp
	 * @param bool $isStart
	 */
	private function insertPlaceholderMeta(
		string $name, DataParsoid $dp, bool $isStart
	) {
		// If node is in a position where the placeholder node will get fostered
		// out, don't bother adding one since the browser and other compliant
		// clients will move the placeholder out of the table.
		if ( $this->remexPipeline->isFosterablePosition() ) {
			return;
		}

		$src = $dp->src ?? null;

		if ( !$src ) {
			if ( !empty( $dp->tsr ) ) {
				$src = $dp->tsr->substr( $this->frame->getSrcText() );
			} elseif ( WTUtils::hasLiteralHTMLMarker( $dp ) ) {
				if ( $isStart ) {
					$src = '<' . $name . '>';
				} else {
					$src = '</' . $name . '>';
				}
			}
		}

		if ( $src ) {
			$metaDP = new DataParsoid;
			$metaDP->src = $src;
			$metaDP->name = $name;
			$this->remexPipeline->insertUnfosteredMeta(
				$this->stashDataAttribs(
					[ 'typeof' => 'mw:Placeholder/StrippedTag' ],
					$metaDP
				)
			);
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
