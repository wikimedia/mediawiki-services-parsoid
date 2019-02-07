<?php

namespace Parsoid\Wt2Html\TT;

use Parsoid\Utils\PHPUtils;
use Parsoid\Tokens\Token;
use Parsoid\Tokens\TagTk;
use Parsoid\Tokens\EndTagTk;
use Parsoid\Tokens\SelfclosingTagTk;

/**
 * PORT-FIXME: Maybe we need to look at all uses of flatten
 * and move it to a real helper in PHPUtils.js
 *
 * Flattens arrays with nested arrays
 *
 * @param array $array array
 * @return array
 */
function array_flatten( $array ) {
	$ret = [];
	foreach ( $array as $key => $value ) {
		if ( is_array( $value ) ) {
			$ret = array_merge( $ret, array_flatten( $value ) );
		} else {
			$ret[$key] = $value;
		}
	}
	return $ret;
}

/**
 * MediaWiki-compatible italic/bold handling as a token stream transformation.
 */
class QuoteTransformer extends TokenHandler {
	/**
	 * Class constructor
	 *
	 * @param object $manager manager environment
	 * @param array $options options
	 */
	public function __construct( $manager, array $options ) {
		parent::__construct( $manager, $options );
		$this->reset();
	}

	/**
	 * Reset the buffering of chunks
	 *
	 */
	public function reset() {
		// Chunks alternate between quote tokens and sequences of non-quote
		// tokens.  The quote tokens are later replaced with the actual tag
		// token for italic or bold.  The first chunk is a non-quote chunk.
		$this->chunks = [];
		// The current chunk we're accumulating into.
		$this->currentChunk = [];
		// last italic / last bold open tag seen.  Used to add autoInserted flags
		// where necessary.
		$this->last = [];

		$this->onAnyEnabled = false;
	}

	/**
	 * Make a copy of the token context
	 *
	 */
	private function startNewChunk() {
		$this->chunks[] = $this->currentChunk;
		$this->currentChunk = [];
	}

	/**
	 * Handles mw-quote tokens and td/th tokens
	 * @param Token $token
	 * @return array
	 */
	public function onTag( $token ) {
		$tkName = isset( $token->name ) ? $token->name : "";
		if ( $tkName === 'mw-quote' ) {
			return $this->onQuote( $token );
		} elseif ( $tkName === 'td' || $tkName === 'th' ) {
			return $this->processQuotes( $token );
		} else {
			return [ "tokens" => [ $token ] ];
		}
	}

	/**
	 * On encountering a NlTk, processes quotes on the current line
	 * @param Token $token
	 * @return Token[]|Token
	 */
	public function onNewline( $token ) {
		return $this->processQuotes( $token );
	}

	/**
	 * On encountering an EOFTk, processes quotes on the current line
	 * @param Token $token
	 * @return Token[]|Token
	 */
	public function onEnd( $token ) {
		return $this->processQuotes( $token );
	}

	/**
	 * Handle onAny tags.
	 *
	 * @param token $token token
	 * @return array
	 */
	public function onAny( $token ) {
		$this->manager->env->log(
			"trace/quote",
			$this->manager->pipelineId,
			"ANY |",
			function () use ( $token ) { return PHPUtils::jsonEncode( $token );
			}
		);

		if ( $this->onAnyEnabled ) {
			$this->currentChunk[] = $token;
			return null;
		} else {
			return [ "tokens" => [ $token ] ];
		}
	}

	/**
	 * Handle QUOTE tags. These are collected in italic/bold lists depending on
	 * the length of quote string. Actual analysis and conversion to the
	 * appropriate tag tokens is deferred until the next NEWLINE token triggers
	 * processQuotes.
	 *
	 * @param object $token token
	 * @return array
	 */
	public function onQuote( $token ) {
		$v = $token->getAttribute( 'value' );
		$qlen = strlen( $v );
		$this->manager->env->log(
			"trace/quote",
			$this->manager->pipelineId,
			"QUOTE |",
			function () use ( $token ) { return PHPUtils::jsonEncode( $token );
			}
		);

		$this->onAnyEnabled = true;

		if ( $qlen === 2 || $qlen === 3 || $qlen === 5 ) {
			$this->startNewChunk();
			$this->currentChunk[] = $token;
			$this->startNewChunk();
		} else {
			error_log( 'should be transformed by tokenizer' );
		}

		return null;
	}

	/**
	 * Handle NEWLINE tokens, which trigger the actual quote analysis on the
	 * collected quote tokens so far.
	 *
	 * @param object $token token
	 * @return array
	 */
	public function processQuotes( $token ) {
		if ( !$this->onAnyEnabled ) {
			// Nothing to do, quick abort.
			return [ "tokens" => [ $token ] ];
		}

		$this->manager->env->log(
			"trace/quote",
			$this->manager->pipelineId,
			"NL    |",
			function () use( $token ) {
				return PHPUtils::jsonEncode( $token );
			}
		);

		if ( ( !is_string( $token ) ) &&
			isset( $token->name ) &&
			( $token->name === 'td' || $token->name === 'th' ) &&
			$token->dataAttribs['stx'] === 'html' ) {
			return [ "tokens" => [ $token ] ];
		}

		// count number of bold and italics
		$numbold = 0;
		$numitalics = 0;
		$chunkCount = count( $this->chunks );
		for ( $i = 1; $i < $chunkCount; $i += 2 ) {
			if ( count( $this->chunks[$i] ) !== 1 ) {	// quote token
				error_log( 'expected 1 quote token' );
			}
			$qlen = strlen( $this->chunks[$i][0]->getAttribute( "value" ) );
			if ( $qlen === 2 || $qlen === 5 ) {
				$numitalics++;
			}
			if ( $qlen === 3 || $qlen === 5 ) {
				$numbold++;
			}
		}

		// balance out tokens, convert placeholders into tags
		if ( ( $numitalics % 2 === 1 ) && ( $numbold % 2 === 1 ) ) {
			$firstsingleletterword = -1;
			$firstmultiletterword = -1;
			$firstspace = -1;
			$chunkCount = count( $this->chunks );
			for ( $i = 1; $i < $chunkCount; $i += 2 ) {
				// only look at bold tags
				if ( strlen( $this->chunks[$i][0]->getAttribute( "value" ) ) !== 3 ) {
					continue;
				}

				$ctxPrevToken = $this->chunks[$i][0]->getAttribute( 'preceding-2chars' );
				$lastCharIndex = strlen( $ctxPrevToken );
				if ( $lastCharIndex >= 1 ) {
					$lastchar = $ctxPrevToken[$lastCharIndex - 1];
				} else {
					$lastchar = "";
				}
				if ( $lastCharIndex >= 2 ) {
					$secondtolastchar = $ctxPrevToken[$lastCharIndex - 2];
				} else {
					$secondtolastchar = "";
				}
				if ( $lastchar === ' ' && $firstspace === -1 ) {
					$firstspace = $i;
				} elseif ( $lastchar !== ' ' ) {
					if ( $secondtolastchar === ' ' && $firstsingleletterword === -1 ) {
						$firstsingleletterword = i;
						// if firstsingleletterword is set, we don't need
						// to look at the options options, so we can bail early
						break;
					} elseif ( $firstmultiletterword === -1 ) {
						$firstmultiletterword = $i;
					}
				}
			}

			// now see if we can convert a bold to an italic and an apostrophe
			if ( $firstsingleletterword > -1 ) {
				$this->convertBold( $firstsingleletterword );
			} elseif ( $firstmultiletterword > -1 ) {
				$this->convertBold( $firstmultiletterword );
			} elseif ( $firstspace > -1 ) {
				$this->convertBold( $firstspace );
			} else {
				// (notice that it is possible for all three to be -1 if, for
				// example, there is only one pentuple-apostrophe in the line)
				// In this case, do no balancing.
			}
		}

		// convert the quote tokens into tags
		$this->convertQuotesToTags();

		// return all collected tokens including the newline
		$this->currentChunk[] = $token;
		$this->startNewChunk();
		// PORT-FIXME: Is there a more efficient way of doing this?
		$res = [ "tokens" => array_flatten( array_merge( [], $this->chunks ) ) ];

		$this->manager->env->log(
			"trace/quote",
			$this->manager->pipelineId,
			"----->",
			function () use ( $res ) {
				return PHPUtils::jsonEncode( $res["tokens"] );
			}
		);

		// prepare for next line
		$this->reset();

		return $res;
	}

	/**
	 * Convert a bold token to italic to balance an uneven number of both bold and
	 * italic tags. In the process, one quote needs to be converted back to text.
	 *
	 * @param int $i index into chunks
	 */
	public function convertBold( $i ) {
		// this should be a bold tag.
		if ( !( $i > 0 && count( $this->chunks[$i] ) === 1
			&& strlen( $this->chunks[$i][0]->getAttribute( "value" ) ) === 3 )
		) {
			error_log( 'this should be a bold tag' );
		}

		// we're going to convert it to a single plain text ' plus an italic tag
		$this->chunks[$i - 1][] = "'";
		$oldbold = $this->chunks[$i][0];
		$tsr = $oldbold->dataAttribs && isset( $oldbold->dataAttribs['tsr'] )
			? $oldbold->dataAttribs['tsr'] : null;
		if ( $tsr ) {
			$tsr = [ $tsr[0] + 1, $tsr[1] ];
		}
		$newbold = new SelfclosingTagTk( 'mw-quote', [], [ "tsr" => $tsr ] );
		$newbold->setAttribute( "value", "''" ); // italic!
		$this->chunks[$i] = [ $newbold ];
	}

	/**
	 * Convert quote tokens to tags, using the same state machine as the
	 * PHP parser uses.
	 */
	public function convertQuotesToTags() {
		$lastboth = -1;
		$state = '';

		$chunkCount = count( $this->chunks );
		for ( $i = 1; $i < $chunkCount; $i += 2 ) {
			if ( count( $this->chunks[$i] ) !== 1 ) {
				error_log( 'expected count chunks[i] == 1' );
			}
			$qlen = strlen( $this->chunks[$i][0]->getAttribute( "value" ) );
			if ( $qlen === 2 ) {
				if ( $state === 'i' ) {
					$this->quoteToTag( $i, [ new EndTagTk( 'i' ) ] );
					$state = '';
				} elseif ( $state === 'bi' ) {
					$this->quoteToTag( $i, [ new EndTagTk( 'i' ) ] );
					$state = 'b';
				} elseif ( $state === 'ib' ) {
					// annoying!
					$this->quoteToTag( $i, [
						new EndTagTk( 'b' ),
						new EndTagTk( 'i' ),
						new TagTk( 'b' ),
					], "bogus two" );
					$state = 'b';
				} elseif ( $state === 'both' ) {
					$this->quoteToTag( $lastboth, [ new TagTk( 'b' ), new TagTk( 'i' ) ] );
					$this->quoteToTag( $i, [ new EndTagTk( 'i' ) ] );
					$state = 'b';
				} else { // state can be 'b' or ''
					$this->quoteToTag( $i, [ new TagTk( 'i' ) ] );
					$state .= 'i';
				}
			} elseif ( $qlen === 3 ) {
				if ( $state === 'b' ) {
					$this->quoteToTag( $i, [ new EndTagTk( 'b' ) ] );
					$state = '';
				} elseif ( $state === 'ib' ) {
					$this->quoteToTag( $i, [ new EndTagTk( 'b' ) ] );
					$state = 'i';
				} elseif ( $state === 'bi' ) {
					// annoying!
					$this->quoteToTag( $i, [
						new EndTagTk( 'i' ),
						new EndTagTk( 'b' ),
						new TagTk( 'i' ),
					], "bogus two" );
					$state = 'i';
				} elseif ( $state === 'both' ) {
					$this->quoteToTag( $lastboth, [ new TagTk( 'i' ), new TagTk( 'b' ) ] );
					$this->quoteToTag( $i, [ new EndTagTk( 'b' ) ] );
					$state = 'i';
				} else { // state can be 'i' or ''
					$this->quoteToTag( $i, [ new TagTk( 'b' ) ] );
					$state .= 'b';
				}
			} elseif ( $qlen === 5 ) {
				if ( $state === 'b' ) {
					$this->quoteToTag( $i, [ new EndTagTk( 'b' ), new TagTk( 'i' ) ] );
					$state = 'i';
				} elseif ( $state === 'i' ) {
					$this->quoteToTag( $i, [ new EndTagTk( 'i' ), new TagTk( 'b' ) ] );
					$state = 'b';
				} elseif ( $state === 'bi' ) {
					$this->quoteToTag( $i, [ new EndTagTk( 'i' ), new EndTagTk( 'b' ) ] );
					$state = '';
				} elseif ( $state === 'ib' ) {
					$this->quoteToTag( $i, [ new EndTagTk( 'b' ), new EndTagTk( 'i' ) ] );
					$state = '';
				} elseif ( $state === 'both' ) {
					$this->quoteToTag( $lastboth, [ new TagTk( 'i' ), new TagTk( 'b' ) ] );
					$this->quoteToTag( $i, [ new EndTagTk( 'b' ), new EndTagTk( 'i' ) ] );
					$state = '';
				} else { // state == ''
					$lastboth = $i;
					$state = 'both';
				}
			}
		}

		// now close all remaining tags.  notice that order is important.
		if ( $state === 'both' ) {
			$this->quoteToTag( $lastboth, [ new TagTk( 'b' ), new TagTk( 'i' ) ] );
			$state = 'bi';
		}
		if ( $state === 'b' || $state === 'ib' ) {
			$this->currentChunk[] = new EndTagTk( 'b' );
			$this->last["b"]->dataAttribs['autoInsertedEnd'] = true;
		}
		if ( $state === 'i' || $state === 'bi' || $state === 'ib' ) {
			$this->currentChunk[] = new EndTagTk( 'i' );
			$this->last["i"]->dataAttribs['autoInsertedEnd'] = true;
		}
		if ( $state === 'bi' ) {
			$this->currentChunk[] = new EndTagTk( 'b' );
			$this->last["b"]->dataAttribs['autoInsertedEnd'] = true;
		}
	}

	/**
	 * Convert italics/bolds into tags.
	 *
	 * @param number $chunk chunk buffer
	 * @param array $tags token
	 * @param bool $ignoreBogusTwo optional defaulß
	 */
	public function quoteToTag( $chunk, $tags, $ignoreBogusTwo = false ) {
		if ( count( $this->chunks[$chunk] ) !== 1 ) {
			error_log( 'expected count chunks[i] == 1' );
		}
		$result = [];
		$oldtag = $this->chunks[$chunk][0];
		// make tsr
		$tsr = $oldtag->dataAttribs && isset( $oldtag->dataAttribs['tsr'] )
			? $oldtag->dataAttribs['tsr'] : null;
		$startpos = $tsr ? $tsr[0] : null;
		$endpos = $tsr ? $tsr[1] : null;
		$numTags = count( $tags );
		for ( $i = 0; $i < $numTags; $i++ ) {
			if ( $tsr ) {
				if ( $i === 0 && $ignoreBogusTwo ) {
					$this->last[$tags[$i]->name]->dataAttribs['autoInsertedEnd'] = true;
				} elseif ( $i === 2 && $ignoreBogusTwo ) {
					$tags[$i]->dataAttribs['autoInsertedStart'] = true;
				} elseif ( $tags[$i]->name === 'b' ) {
					$tags[$i]->dataAttribs['tsr'] = [ $startpos, $startpos + 3 ];
					$startpos = $tags[$i]->dataAttribs['tsr'][1];
				} elseif ( $tags[$i]->name === 'i' ) {
					$tags[$i]->dataAttribs['tsr'] = [ $startpos, $startpos + 2 ];
					$startpos = $tags[$i]->dataAttribs['tsr'][1];
				} else {
					error_log( 'unexpected final else clause encountered' );
				}
			}
			$this->last[$tags[$i]->name] = ( $tags[$i]->getType() === "EndTagTk" ) ? null : $tags[$i];
			$result[] = $tags[$i];
		}
		if ( $tsr ) {
			if ( $startpos !== $endpos ) {
				error_log( 'Start: $startpos !== end: $endpos' );
			}
		}
		$this->chunks[$chunk] = $result;
	}
}
