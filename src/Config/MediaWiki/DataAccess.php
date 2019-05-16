<?php

namespace Parsoid\Config\MediaWiki;

use ContentHandler;
use File;
use LinkBatch;
use Linker;
use MediaWiki\Revision\RevisionStore;
use Parsoid\Config\DataAccess as IDataAccess;

class DataAccess implements IDataAccess {

	/** @var RevisionStore */
	private $revStore;

	/**
	 * @param RevisionStore $revStore
	 */
	public function __construct( RevisionStore $revStore ) {
		$this->revStore = $revStore;
	}

	/**
	 * @param File $file
	 * @param array $hp
	 * @return array
	 */
	private function makeTransformOptions( $file, array $hp ): array {
		// Validate the input parameters like Parser::makeImage()
		$handler = $file->getHandler();
		if ( !$handler ) {
			return []; // will get iconThumb()
		}
		foreach ( $hp as $name => $value ) {
			if ( !$handler->validateParam( $name, $value ) ) {
				unset( $hp[$name] );
			}
		}

		// This part is similar to Linker::makeImageLink(). If there is no width,
		// set one based on the source file size.
		$page = isset( $hp['page'] ) ? $hp['page'] : 1;
		if ( !isset( $hp['width'] ) ) {
			if ( isset( $hp['height'] ) && $file->isVectorized() ) {
				// If it's a vector image, and user only specifies height
				// we don't want it to be limited by its "normal" width.
				global $wgSVGMaxSize;
				$hp['width'] = $wgSVGMaxSize;
			} else {
				$hp['width'] = $file->getWidth( $page );
			}

			// We don't need to fill in a default thumbnail width here, since
			// that is done by Parsoid. Parsoid always sets the width parameter
			// for thumbnails.
		}

		return $hp;
	}

	/** @inheritDoc */
	public function getRedlinkData( PageConfig $pageConfig, array $titles ): array {
		$titleObjs = [];
		foreach ( $titles as $name ) {
			$titleObjs[$name] = Title::newFromText( $name );
		}
		$linkBatch = new LinkBatch( $titleObjs );
		$linkBatch->execute();

		// This depends on the Disambiguator extension :(
		// @todo Either merge that extension into core, or we'll need to make
		// a "ParsoidGetRedlinkData" hook that Disambiguator can implement.
		$pageProps = PageProps::getInstance();
		$properties = $pageProps->getProperties( $titleObjs, [ 'disambiguation' ] );

		$ret = [];
		foreach ( $titleObjs as $name => $obj ) {
			$ret[$name] = [
				'missing' => !$obj->exists(),
				'known' => $obj->isKnown(),
				'redirect' => $obj->isRedirect(),
				'disambiguation' => isset( $properties[$obj->getArticleID()] ),
			];
		}
		return $ret;
	}

	/** @inheritDoc */
	public function getFileInfo( PageConfig $pageConfig, array $files ): array {
		$page = Title::newFromText( $pageConfig->getTitle() );
		$fileObjs = RepoGroup::singleton()->findFiles( array_keys( $files ) );
		$ret = [];
		foreach ( $files as $filename => $dims ) {
			$file = $fileObjs[$filename] ?? null;
			if ( !$file ) {
				$ret[$filename] = null;
				continue;
			}

			$result = [
				'width' => $file->getWidth(),
				'height' => $file->getHeight(),
				'size' => $file->getSize(),
				'mediatype' => $file->getMediaType(),
				'mime' => $file->getMimeType(),
				'url' => wfExpandUrl( $file->getFullUrl(), PROTO_CURRENT ),
				'mustRender' => $file->mustRender(),
				'badFile' => (bool)wfIsBadImage( $filename, $page ?: false ),
			];

			$length = $file->getLength();
			if ( $length ) {
				$result['duration'] = (float)$length;
			}
			$txopts = $this->makeTransformOptions( $file, $txopts );
			$mto = $file->transform( $txopts );
			if ( $mto ) {
				if ( $mto->isError() ) {
					$result['thumberror'] = $mto->toText();
				} else {
					if ( $txopts ) {
						// Do srcset scaling
						Linker::processResponsiveImages( $file, $mto, $txopts );
						if ( count( $mto->responsiveUrls ) ) {
							$result['responsiveUrls'] = [];
							foreach ( $mto->responsiveUrls as $density => $url ) {
								$result['responsiveUrls'][$density] = wfExpandUrl(
									$url, PROTO_CURRENT );
							}
						}
					}

					// Proposed MediaTransformOutput serialization method for T51896 etc.
					if ( is_callable( [ $mto, 'getAPIData' ] ) ) {
						$result['thumbdata'] = $mto->getAPIData();
					}

					$result['thumburl'] = wfExpandUrl( $mto->getUrl(), PROTO_CURRENT );
					$result['thumbwidth'] = $mto->getWidth();
					$result['thumbheight'] = $mto->getHeight();
				}
			} else {
				$result['thumberror'] = "Presumably, invalid parameters, despite validation.";
			}

			$ret[$filename] = $result;
		}

		return $ret;
	}

	/** @inheritDoc */
	public function doPst( PageConfig $pageConfig, string $wikitext ): string {
		$titleObj = Title::newFromText( $pageConfig->getTitle() );
		$popts = $pageConfig->getParserOptions();

		return ContentHandler::makeContent( $wikitext, $titleObj, CONTENT_MODEL_WIKITEXT )
			->preSaveTransform( $titleObj, $popts->getUser(), $popts )
			->serialize();
	}

	/** @inheritDoc */
	public function parseWikitext(
		PageConfig $pageConfig, string $wikitext, ?int $revid = null
	): array {
		$titleObj = Title::newFromText( $pageConfig->getTitle() );
		$popts = $pageConfig->getParserOptions();

		$pout = ContentHandler::makeContent( $wikitext, $titleObj, CONTENT_MODEL_WIKITEXT )
			->getParserOutput( $titleObj, $revid, $popts );

		$categories = [];
		foreach ( $out->getCategories() as $cat => $sortkey ) {
			$categories[] = [ 'name' => $cat, 'sortkey' => $sortkey ];
		}

		return [
			'html' => $out->getText( [ 'unwrap' => true ] ),
			'modules' => array_values( array_unique( $out->getModules() ) ),
			'modulescripts' => [], // $out->getModuleScripts() is deprecated and always returns []
			'modulestyles' => array_values( array_unique( $out->getModuleStyles() ) ),
			'categories' => $out->getCategories(),
			// @todo ParsoidBatchAPI also returns page properties, but they don't seem to be used in Parsoid?
		];
	}

	/** @inheritDoc */
	public function preprocessWikitext(
		PageConfig $pageConfig, string $wikitext, ?int $revid = null
	): array {
		$titleObj = Title::newFromText( $pageConfig->getTitle() );
		$popts = $pageConfig->getParserOptions();

		$wikitext = $wgParser->preprocess( $wikitext, $titleObj, $popts, $revid );
		$out = $wgParser->getOutput();
		return [
			'wikitext' => $wikitext,
			'modules' => array_values( array_unique( $out->getModules() ) ),
			'modulescripts' => [], // $out->getModuleScripts() is deprecated and always returns []
			'modulestyles' => array_values( array_unique( $out->getModuleStyles() ) ),
			'categories' => $out->getCategories(),
			// @todo ParsoidBatchAPI also returns page properties, but they don't seem to be used in Parsoid?
		];
	}

	/** @inheritDoc */
	public function fetchPageContent(
		PageConfig $pageConfig, string $title, int $oldid = 0
	): ?PageContent {
		$titleObj = Title::newFromText( $title );

		if ( $oldid ) {
			$rev = $this->revStore->getRevisionByTitle( $titleObj, $oldid );
		} else {
			$rev = call_user_func(
				$pageConfig->getParserOptions()->getCurrentRevisionCallback(),
				$titleObj,
				$pageConfig->getParser()
			);
		}
		if ( $rev instanceof \Revision ) {
			$rev = $rev->getRevisionRecord();
		}

		return $rev ? new MediaWikiPageContent( $rev ) : null;
	}

	/** @inheritDoc */
	public function fetchTemplateData( PageConfig $pageConfig, string $title ): ?array {
		$ret = null;
		// @todo: Document this hook in MediaWiki
		Hooks::runWithoutAbort( 'ParsoidFetchTemplateData', [ $title, &$ret ] );
		return $ret;
	}

}
