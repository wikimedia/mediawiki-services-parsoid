<?php
declare( strict_types = 1 );

namespace MWParsoid\Test;

class IntegratedTestRunner extends \ParserTestRunner {

	/**
	 * Override the base class runTest() method to use Parsoid.
	 * @inheritDoc
	 */
	public function runTest( $test ) {
		// Skip tests targetting features Parsoid doesn't (yet?) support
		if ( isset( $opts['pst'] ) || isset( $opts['msg'] ) ||
			 isset( $opts['section'] ) || isset( $opts['replace'] ) ||
			 isset( $opts['comment'] ) || isset( $opts['preload'] ) ) {
			return false;
		}

		wfDebug( __METHOD__ . ": running {$test['desc']}" );
		$opts = $this->parseOptions( $test['options'] ); // XXX FIXME PRIVATE
		$teardownGuard = $this->perTestSetup( $test );

		$context = RequestContext::getMain();
		$user = $context->getUser();
		$options = ParserOptions::newFromContext( $context );
		$options->setTimestamp( $this->getFakeTimestamp() );
		$revId = 1337; // see Parser::getRevisionId()
		$title = isset( $opts['title'] )
			? Title::newFromText( $opts['title'] )
			: $this->defaultTitle;

		if ( isset( $opts['lastsavedrevision'] ) ) {
			$content = new WikitextContent( $test['input'] );
			$title = Title::newFromRow( (object)[
				'page_id' => 187,
				'page_len' => $content->getSize(),
				'page_latest' => 1337,
				'page_namespace' => $title->getNamespace(),
				'page_title' => $title->getDBkey(),
				'page_is_redirect' => 0
			] );
			$rev = new Revision(
				[
					'id' => $title->getLatestRevID(),
					'page' => $title->getArticleID(),
					'user' => $user,
					'content' => $content,
					'timestamp' => $this->getFakeTimestamp(),
					'title' => $title
				],
				Revision::READ_LATEST,
				$title
			);
			$oldCallback = $options->getCurrentRevisionCallback();
			$options->setCurrentRevisionCallback(
				function ( Title $t, $parser ) use ( $title, $rev, $oldCallback ) {
					if ( $t->equals( $title ) ) {
						return $rev;
					} else {
						return call_user_func( $oldCallback, $t, $parser );
					}
				}
			);
		}

		if ( isset( $opts['maxincludesize'] ) ) {
			$options->setMaxIncludeSize( $opts['maxincludesize'] );
		}
		if ( isset( $opts['maxtemplatedepth'] ) ) {
			$options->setMaxTemplateDepth( $opts['maxtemplatedepth'] );
		}

		$local = isset( $opts['local'] );
		$preprocessor = $opts['preprocessor'] ?? null;
		$parser = $this->getParser( $preprocessor );

		if ( isset( $opts['styletag'] ) ) {
			// For testing the behavior of <style> (including those deduplicated
			// into <link> tags), add tag hooks to allow them to be generated.
			$parser->setHook( 'style', function ( $content, $attributes, $parser ) {
				$marker = Parser::MARKER_PREFIX . '-style-' . md5( $content ) . Parser::MARKER_SUFFIX;
				$parser->mStripState->addNoWiki( $marker, $content );
				return Html::inlineStyle( $marker, 'all', $attributes );
			} );
			$parser->setHook( 'link', function ( $content, $attributes, $parser ) {
				return Html::element( 'link', $attributes );
			} );
		}

		// Run the parser test!

		$output = $parser->parse( $test['input'], $title, $options, true, true, $revId );
		$out = $output->getText( [
			'allowTOC' => !isset( $opts['notoc'] ),
			'unwrap' => !isset( $opts['wrap'] ),
		] );
		if ( isset( $opts['tidy'] ) ) {
			$out = preg_replace( '/\s+$/', '', $out );
		}

		if ( isset( $opts['showtitle'] ) ) {
			if ( $output->getTitleText() ) {
				$title = $output->getTitleText();
			}

			$out = "$title\n$out";
		}

		if ( isset( $opts['showindicators'] ) ) {
			$indicators = '';
			foreach ( $output->getIndicators() as $id => $content ) {
				$indicators .= "$id=$content\n";
			}
			$out = $indicators . $out;
		}

		if ( isset( $opts['ill'] ) ) {
			$out = implode( ' ', $output->getLanguageLinks() );
		} elseif ( isset( $opts['cat'] ) ) {
			$out = '';
			foreach ( $output->getCategories() as $name => $sortkey ) {
				if ( $out !== '' ) {
					$out .= "\n";
				}
				$out .= "cat=$name sort=$sortkey";
			}
		}

		if ( isset( $output ) && isset( $opts['showflags'] ) ) {
			$actualFlags = array_keys( TestingAccessWrapper::newFromObject( $output )->mFlags );
			sort( $actualFlags );
			$out .= "\nflags=" . implode( ', ', $actualFlags );
		}

		ScopedCallback::consume( $teardownGuard );

		$expected = $test['result'];
		if ( count( $this->normalizationFunctions ) ) {
			$expected = ParserTestResultNormalizer::normalize(
				$test['expected'], $this->normalizationFunctions );
			$out = ParserTestResultNormalizer::normalize( $out, $this->normalizationFunctions );
		}

		$testResult = new ParserTestResult( $test, $expected, $out );
		return $testResult;
	}
}
