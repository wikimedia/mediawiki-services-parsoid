<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Closure;
use DOMDocument;
use DOMDocumentFragment;
use DOMElement;
use DOMNode;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Config\PageConfig;
use Wikimedia\Parsoid\Config\SiteConfig;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Core\Sanitizer;
use Wikimedia\Parsoid\Html2wt\SerializerState;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Utils\Title;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\DOMPostProcessor;
use Wikimedia\Parsoid\Wt2Html\Frame;

/**
 * Extensions are expected to use only these interfaces and strongly discouraged from
 * calling Parsoid code directly. Code review is expected to catch these discouraged
 * code patterns. We'll have to finish grappling with the extension and hooks API
 * to go down this path seriously. Till then, we'll have extensions leveraging existing
 * code as in the native extension code in this repository.
 */
class ParsoidExtensionAPI {
	/** @var Env */
	private $env;

	/** @var ?Frame */
	private $frame;

	/** @var ?ExtensionTag */
	public $extTag;

	/**
	 * @var ?array TokenHandler options
	 */
	private $wt2htmlOpts;

	/**
	 * @var ?array Serialiation options / state
	 */
	private $html2wtOpts;

	/**
	 * @var ?SerializerState
	 */
	private $serializerState;

	/**
	 * Errors collected while parsing.  This is used to indicate that, although
	 * an extension is returning a dom fragment, errors were encountered while
	 * generating it and should be marked up with the mw:Error typeof.
	 *
	 * @var array
	 */
	private $errors = [];

	/**
	 * @param Env $env
	 * @param ?array $options
	 *  - wt2html: used in wt->html direction
	 *    - frame: (Frame)
	 *    - parseOpts: (array)
	 *      - extTag: (string)
	 *      - extTagOpts: (array)
	 *      - inTemplate: (bool)
	 *    - extTag: (ExtensionTag)
	 *  - html2wt: used in html->wt direction
	 *    - state: (SerializerState)
	 */
	public function __construct(
		Env $env, ?array $options = null
	) {
		$this->env = $env;
		$this->wt2htmlOpts = $options['wt2html'] ?? null;
		$this->html2wtOpts = $options['html2wt'] ?? null;
		$this->serializerState = $this->html2wtOpts['state'] ?? null;
		$this->frame = $this->wt2htmlOpts['frame'] ?? null;
		$this->extTag = $this->wt2htmlOpts['extTag'] ?? null;
	}

	/**
	 * Collect errors while parsing.  If processing can't continue, an
	 * ExtensionError should be thrown instead.
	 *
	 * $key and $params are basically the arguments to wfMessage, although they
	 * will be stored in the data-mw of the encapsulation wrapper.
	 *
	 * See https://www.mediawiki.org/wiki/Specs/HTML#Error_handling
	 *
	 * The returned fragment can be inserted in the dom and will be populated
	 * with the localized message.  See T266666
	 *
	 * @unstable
	 * @param string $key
	 * @param mixed ...$params
	 * @return DOMDocumentFragment
	 */
	public function pushError( string $key, ...$params ): DOMDocumentFragment {
		$err = [ 'key' => $key ];
		if ( count( $params ) > 0 ) {
			$err['params'] = $params;
		}
		$this->errors[] = $err;
		return WTUtils::createLocalizationFragment( $this->getTopLevelDoc(), $err );
	}

	/**
	 * @return array
	 */
	public function getErrors(): array {
		return $this->errors;
	}

	/**
	 * Returns the main document we're parsing.  Extension content is parsed
	 * to fragments of this document.
	 *
	 * @return DOMDocument
	 */
	public function getTopLevelDoc(): DOMDocument {
		return $this->env->topLevelDoc;
	}

	/**
	 * Get a new about id for marking extension output
	 * FIXME: This should never really be needed since the extension API
	 * handles this on behalf of extensions, but Cite has one use case
	 * where implicit <references /> output is added.
	 *
	 * @return string
	 */
	public function newAboutId(): string {
		return $this->env->newAboutId();
	}

	/**
	 * Get the site configuration to let extensions customize
	 * their behavior based on how the wiki is configured.
	 *
	 * @return SiteConfig
	 */
	public function getSiteConfig(): SiteConfig {
		return $this->env->getSiteConfig();
	}

	/**
	 * FIXME: Unsure if we need to provide this access yet
	 * Get the page configuration
	 * @return PageConfig
	 */
	public function getPageConfig(): PageConfig {
		return $this->env->getPageConfig();
	}

	/**
	 * Get the URI to link to a title
	 * @param Title $title
	 * @return string
	 */
	public function getTitleUri( Title $title ): string {
		return $this->env->makeLink( $title );
	}

	/**
	 * Get an URI for the current page
	 * @return string
	 */
	public function getPageUri(): string {
		$title = Title::newFromText(
			$this->env->getPageConfig()->getTitle(),
			$this->env->getSiteConfig()
		);
		return $this->getTitleUri( $title );
	}

	/**
	 * Make a title from an input string
	 * @param string $str
	 * @param int $namespaceId
	 * @return ?Title
	 */
	public function makeTitle( string $str, int $namespaceId ): ?Title {
		return $this->env->makeTitleFromText( $str, $namespaceId, true /* no exceptions */ );
	}

	/**
	 * Are we parsing in a template context?
	 * @return bool
	 */
	public function inTemplate(): bool {
		return $this->wt2htmlOpts['parseOpts']['inTemplate'] ?? false;
	}

	/**
	 * FIXME: Is this something that can come from the frame?
	 * If we are parsing in the context of a parent extension tag,
	 * return the name of that extension tag
	 * @return string|null
	 */
	public function parentExtTag(): ?string {
		return $this->wt2htmlOpts['parseOpts']['extTag'] ?? null;
	}

	/**
	 * FIXME: Is this something that can come from the frame?
	 * If we are parsing in the context of a parent extension tag,
	 * return the parsing options set by that tag.
	 * @return array
	 */
	public function parentExtTagOpts(): array {
		return $this->wt2htmlOpts['parseOpts']['extTagOpts'] ?? [];
	}

	/**
	 * Get the content DOM corresponding to an id
	 * @param string $contentId
	 * @return DOMDocumentFragment
	 */
	public function getContentDOM( string $contentId ): DOMDocumentFragment {
		return $this->env->getDOMFragment( $contentId );
	}

	/**
	 * @param string $contentId
	 */
	public function clearContentDOM( string $contentId ) {
		$this->env->removeDOMFragment( $contentId );
	}

	/**
	 * Parse wikitext to DOM
	 *
	 * @param string $wikitext
	 * @param array $opts
	 * - srcOffsets
	 * - frame
	 * - parseOpts
	 *   - extTag
	 *   - extTagOpts
	 *   - context "inline", "block", etc. Currently, only "inline" is supported
	 * @param bool $sol
	 * @return DOMDocumentFragment
	 */
	public function wikitextToDOM(
		string $wikitext, array $opts, bool $sol
	): DOMDocumentFragment {
		if ( $wikitext === '' ) {
			$domFragment = $this->getTopLevelDoc()->createDocumentFragment();
		} else {
			// Parse content to DOM and pass DOM-fragment token back to the main pipeline.
			// The DOM will get unwrapped and integrated  when processing the top level document.
			$parseOpts = $opts['parseOpts'] ?? [];
			$srcOffsets = $opts['srcOffsets'] ?? null;
			$frame = $this->frame;
			if ( !empty( $opts['processInNewFrame'] ) ) {
				$frame = $frame->newChild( $frame->getTitle(), [], $wikitext );
				$srcOffsets = new SourceRange( 0, strlen( $wikitext ) );
			}
			$domFragment = PipelineUtils::processContentInPipeline(
				$this->env, $frame, $wikitext,
				[
					// Full pipeline for processing content
					'pipelineType' => 'text/x-mediawiki/full',
					'pipelineOpts' => [
						'expandTemplates' => true,
						'extTag' => $parseOpts['extTag'],
						'extTagOpts' => $parseOpts['extTagOpts'] ?? null,
						'inTemplate' => $this->inTemplate(),
						'inlineContext' => ( $parseOpts['context'] ?? '' ) === 'inline',
					],
					'srcOffsets' => $srcOffsets,
					'sol' => $sol,
				]
			);

			if ( !empty( $opts['clearDSROffsets'] ) ) {
				$dsrFn = function ( DOMSourceRange $dsr ) {
					return null;
				};
			} else {
				$dsrFn = $opts['shiftDSRFn'] ?? null;
			}

			if ( $dsrFn ) {
				ContentUtils::shiftDSR( $this->env, $domFragment, $dsrFn );
			}
		}
		return $domFragment;
	}

	/**
	 * Parse extension tag to DOM. Beyond parsing the contents of the extension tag,
	 * this wraps the contents in a custom wrapper element (ex: <div>), sanitizes
	 * the arguments of the extension args and sets some content flags on the wrapper.
	 *
	 * @param array $extArgs
	 * @param string $leadingWS
	 * @param string $wikitext
	 * @param array $opts
	 * - srcOffsets
	 * - frame
	 * - wrapperTag
	 * - parseOpts
	 *   - extTag
	 *   - extTagOpts
	 *   - context
	 * @return DOMDocumentFragment
	 */
	public function extTagToDOM(
		array $extArgs, string $leadingWS, string $wikitext, array $opts
	): DOMDocumentFragment {
		$extTagOffsets = $this->extTag->getOffsets();
		if ( !isset( $opts['srcOffsets'] ) ) {
			$opts['srcOffsets'] = new SourceRange(
				$extTagOffsets->innerStart() + strlen( $leadingWS ),
				$extTagOffsets->innerEnd()
			);
		}

		$domFragment = $this->wikitextToDOM( $wikitext, $opts, true /* sol */ );

		// Create a wrapper and migrate content into the wrapper
		$wrapper = $domFragment->ownerDocument->createElement(
			$opts['wrapperTag']
		);
		DOMUtils::migrateChildren( $domFragment, $wrapper );
		$domFragment->appendChild( $wrapper );

		// Sanitize args and set on the wrapper
		Sanitizer::applySanitizedArgs( $this->env->getSiteConfig(), $wrapper, $extArgs );

		// Mark empty content DOMs
		if ( $wikitext === '' ) {
			DOMDataUtils::getDataParsoid( $wrapper )->empty = true;
		}

		if ( !empty( $this->extTag->isSelfClosed() ) ) {
			DOMDataUtils::getDataParsoid( $wrapper )->selfClose = true;
		}

		return $domFragment;
	}

	/**
	 * Process a specific extension arg as wikitext and return its DOM equivalent.
	 * By default, this method processes the argument value in inline context and normalizes
	 * every whitespace character to a single space.
	 * @param KV[] $extArgs
	 * @param string $key should be lower-case
	 * @param bool $context
	 * @return ?DOMDocumentFragment
	 */
	public function extArgToDOM(
		array $extArgs, string $key, string $context = "inline"
	): ?DOMDocumentFragment {
		$argKV = KV::lookupKV( $extArgs, strtolower( $key ) );
		if ( $argKV === null || !$argKV->v ) {
			return null;
		}

		if ( $context === "inline" ) {
			// `normalizeExtOptions` can mess up source offsets as well as the string
			// that ought to be processed as wikitext. So, we do our own whitespace
			// normalization of the original source here.
			//
			// If 'context' is 'inline' below, it ensures indent-pre / p-wrapping is suppressed.
			// So, the normalization is primarily for HTML string parity.
			$argVal = preg_replace( '/[\t\r\n ]/', ' ', $argKV->vsrc );
		} else {
			$argVal = $argKV->vsrc;
		}

		return $this->wikitextToDOM(
			$argVal,
			[
				'parseOpts' => [
					'extTag' => $this->extTag->getName(),
					'context' => $context,
				],
				'srcOffsets' => $argKV->valueOffset(),
			],
			false // inline context => no sol state
		);
	}

	/**
	 * Convert the ext args representation from an array of KV objects
	 * to a plain associative array mapping arg name strings to arg value strings.
	 * @param array<KV> $extArgs
	 * @return array<string,string>
	 */
	public function extArgsToArray( array $extArgs ): array {
		return TokenUtils::kvToHash( $extArgs );
	}

	/**
	 * This method finds a requested arg by key name and return its current value.
	 * If a closure is passed in to update the current value, it is used to update the arg.
	 *
	 * @param KV[] &$extArgs Array of extension args
	 * @param string $key Argument key whose value needs an update
	 * @param ?Closure $updater $updater will get the existing string value
	 *   for the arg and is expected to return an updated value.
	 * @return ?string
	 */
	public function findAndUpdateArg(
		array &$extArgs, string $key, ?Closure $updater = null
	): ?string {
		// FIXME: This code will get an overhaul when T250854 is resolved.
		foreach ( $extArgs as $i => $kv ) {
			$k = TokenUtils::tokensToString( $kv->k );
			if ( strtolower( trim( $k ) ) === strtolower( $key ) ) {
				$val = $kv->v;
				if ( $updater ) {
					$kv = clone $kv;
					$kv->v = $updater( TokenUtils::tokensToString( $val ) );
					$extArgs[$i] = $kv;
				}
				return $val;
			}
		}

		return null;
	}

	/**
	 * This method adds a new argument to the extension args array
	 * @param KV[] &$extArgs
	 * @param string $key
	 * @param string $value
	 */
	public function addNewArg( array &$extArgs, string $key, string $value ): void {
		$extArgs[] = new KV( $key, $value );
	}

	// TODO: Provide support for extensions to register lints
	// from their customized lint handlers.

	/**
	 * Forwards the logging request to the underlying logger
	 * @param mixed ...$args
	 */
	public function log( ...$args ): void {
		$this->env->log( ...$args );
	}

	/**
	 * Extensions might be interested in examining their content embedded
	 * in data-mw attributes that don't otherwise show up in the DOM.
	 *
	 * Ex: inline media captions that aren't rendered, language variant markup,
	 *     attributes that are transcluded. More scenarios might be added later.
	 *
	 * @param DOMElement $elt The node whose data attributes need to be examined
	 * @param Closure $proc The processor that will process the embedded HTML
	 */
	public function processHiddenHTMLInDataAttributes( DOMElement $elt, Closure $proc ): void {
		/* -----------------------------------------------------------------
		 * FIXME: This works but feels special cased, maybe?
		 *
		 * We should also be running DOM cleanup passes on embedded HTML
		 * in data-mw and other attributes.
		 *
		 * See T214994
		 * ----------------------------------------------------------------- */
		// Expanded attributes
		if ( DOMUtils::matchTypeOf( $elt, '/^mw:ExpandedAttrs$/' ) ) {
			$dmw = DOMDataUtils::getDataMw( $elt );
			if ( $dmw->attribs ?? null ) {
				foreach ( $dmw->attribs as &$a ) {
					foreach ( $a as $kOrV ) {
						if ( gettype( $kOrV ) !== 'string' && isset( $kOrV->html ) ) {
							$kOrV->html = $proc( $kOrV->html );
						}
					}
				}
			}
		}

		// Language variant markup
		if ( DOMUtils::matchTypeOf( $elt, '/^mw:LanguageVariant$/' ) ) {
			$dmwv = DOMDataUtils::getJSONAttribute( $elt, 'data-mw-variant', null );
			if ( $dmwv ) {
				if ( isset( $dmwv->disabled ) ) {
					$dmwv->disabled->t = $proc( $dmwv->disabled->t );
				}
				if ( isset( $dmwv->twoway ) ) {
					foreach ( $dmwv->twoway as $l ) {
						$l->t = $proc( $l->t );
					}
				}
				if ( isset( $dmwv->oneway ) ) {
					foreach ( $dmwv->oneway as $l ) {
						$l->f = $proc( $l->f );
						$l->t = $proc( $l->t );
					}
				}
				if ( isset( $dmwv->filter ) ) {
					$dmwv->filter->t = $proc( $dmwv->filter->t );
				}
				DOMDataUtils::setJSONAttribute( $elt, 'data-mw-variant', $dmwv );
			}
		}

		// Inline media -- look inside the data-mw attribute
		if ( WTUtils::isInlineMedia( $elt ) ) {
			$dmw = DOMDataUtils::getDataMw( $elt );
			$caption = $dmw->caption ?? null;
			if ( $caption ) {
				$dmw->caption = $proc( $caption );
			}
		}
	}

	/**
	 * Copy $from->childNodes to $to and clone the data attributes of $from
	 * to $to.
	 *
	 * @param DOMElement $from
	 * @param DOMElement $to
	 */
	public static function migrateChildrenAndTransferWrapperDataAttribs(
		DOMElement $from, DOMElement $to
	): void {
		DOMUtils::migrateChildren( $from, $to );
		DOMDataUtils::setDataParsoid(
			$to, Utils::clone( DOMDataUtils::getDataParsoid( $from ) )
		);
		DOMDataUtils::setDataMw(
			$to, Utils::clone( DOMDataUtils::getDataMw( $from ) )
		);
	}

	/**
	 * Parse input string into DOM.
	 * NOTE: This leaves the DOM in Parsoid-canonical state and is the preferred method
	 * to convert HTML to DOM that will be passed into Parsoid's code processing code.
	 *
	 * @param string $html
	 * @return DOMDocumentFragment
	 */
	public function htmlToDom( string $html ): DOMDocumentFragment {
		return ContentUtils::createAndLoadDocumentFragment(
			$this->getTopLevelDoc(), $html
		);
	}

	/**
	 * Serialize DOM element to string (inner/outer HTML is controlled by flag).
	 * If $releaseDom is set to true, the DOM will be left in non-canonical form
	 * and is not safe to use after this call. This is primarily a performance optimization.
	 *
	 * @param DOMNode $node
	 * @param bool $innerHTML if true, inner HTML of the element will be returned
	 *    This flag defaults to false
	 * @param bool $releaseDom if true, the DOM will not be in canonical form after this call
	 *    This flag defaults to false
	 * @return string
	 */
	public function domToHtml(
		DOMNode $node, bool $innerHTML = false, bool $releaseDom = false
	): string {
		// FIXME: This is going to drop any diff markers but since
		// the dom differ doesn't traverse into extension content (right now),
		// none should exist anyways.
		$html = ContentUtils::ppToXML( $node, [ 'innerXML' => $innerHTML ] );
		if ( !$releaseDom ) {
			DOMDataUtils::visitAndLoadDataAttribs( $node );
		}
		return $html;
	}

	/**
	 * Bit flags describing escaping / serializing context in html -> wt mode
	 */
	public const IN_SOL = 1;
	public const IN_MEDIA = 2;
	public const IN_LINK = 4;
	public const IN_IMG_CAPTION = 8;
	public const IN_OPTION = 16;

	/**
	 * FIXME: This is a bit broken - shouldn't be needed ideally
	 * @param string $flag
	 */
	public function setHtml2wtStateFlag( string $flag ) {
		$this->serializerState->{$flag} = true;
	}

	/**
	 * Emit the opening tag (including attributes) for the extension
	 * represented by this node.
	 *
	 * @param DOMElement $node
	 * @return string
	 */
	public function extStartTagToWikitext( DOMElement $node ): string {
		$state = $this->serializerState;
		return $state->serializer->serializeExtensionStartTag( $node, $state );
	}

	/**
	 * Convert the input DOM to wikitext.
	 *
	 * @param array $opts
	 *  - extName: (string) Name of the extension whose body we are serializing
	 *  - inPHPBlock: (bool) FIXME: This needs to be removed
	 * @param DOMElement $node DOM to serialize
	 * @param bool $releaseDom If $releaseDom is set to true, the DOM will be left in
	 *  non-canonical form and is not safe to use after this call. This is primarily a
	 *  performance optimization.  This flag defaults to false.
	 * @return mixed
	 */
	public function domToWikitext( array $opts, DOMElement $node, bool $releaseDom = false ) {
		// FIXME: WTS expects the input DOM to be a <body> element!
		// Till that is fixed, we have to go through this round-trip!
		// TODO: Move $node children to a fragment and call `$serializer->domToWikitext`
		return $this->htmlToWikitext( $opts, $this->domToHtml( $node, $releaseDom ) );
	}

	/**
	 * Convert the HTML body of an extension to wikitext
	 *
	 * @param array $opts
	 *  - extName: (string) Name of the extension whose body we are serializing
	 *  - inPHPBlock: (bool) FIXME: This needs to be removed
	 * @param string $html HTML for the extension's body
	 * @return string
	 */
	public function htmlToWikitext( array $opts, string $html ): string {
		// Type cast so phan has more information to ensure type safety
		$state = $this->serializerState;
		$opts['env'] = $this->env;
		return $state->serializer->htmlToWikitext( $opts, $html );
	}

	/**
	 * @param DOMElement $elt
	 * @param int $context OR-ed bit flags specifying escaping / serialization context
	 * @return string
	 */
	public function domChildrenToWikitext( DOMElement $elt, int $context ): string {
		$state = $this->serializerState;
		if ( $context & self::IN_IMG_CAPTION ) {
			if ( $context & self::IN_OPTION ) {
				$escapeHandler = 'mediaOptionHandler'; // Escapes "|" as well
			} else {
				$escapeHandler = 'wikilinkHandler'; // image captions show up in wikilink syntax
			}
			$out = $state->serializeCaptionChildrenToString( $elt,
				[ $state->serializer->wteHandlers, $escapeHandler ] );
		} else {
			throw new \RuntimeException( 'Not yet supported!' );
		}
		return $out;
	}

	/**
	 * Escape any wikitext like constructs in a string so that when the output
	 * is parsed, it renders as a string. The escaping is sensitive to the context
	 * in which the string is embedded. For example, a "*" is not safe at the start
	 * of a line (since it will parse as a list item), but is safe if it is not in
	 * a start of line context. Similarly the "|" character is safe outside tables,
	 * links, and transclusions.
	 *
	 * @param string $str
	 * @param DOMNode $node
	 * @param int $context OR-ed bit flags specifying escaping / serialization context
	 * @return string
	 */
	public function escapeWikitext( string $str, DOMNode $node, int $context ): string {
		if ( $context & ( self::IN_MEDIA | self::IN_LINK ) ) {
			$state = $this->serializerState;
			return $state->serializer->wteHandlers->escapeLinkContent(
				$state, $str,
				(bool)( $context & self::IN_SOL ),
				$node,
				(bool)( $context & self::IN_MEDIA )
			);
		} else {
			throw new \RuntimeException( 'Not yet supported!' );
		}
	}

	/**
	 * EXTAPI-FIXME: We have to figure out what it means to run a DOM PP pass
	 * (and what processors and what handlers apply) on content models that are
	 * not wikitext. For now, we are only storing data attribs back to the DOM
	 * and adding metadata to the page.
	 *
	 * @param DOMDocument $doc
	 */
	public function postProcessDOM( DOMDocument $doc ): void {
		$env = $this->env;
		// From CleanUp::cleanupAndSaveDataParsoid
		DOMDataUtils::visitAndStoreDataAttribs( DOMCompat::getBody( $doc ), [
			'storeInPageBundle' => $env->pageBundle,
			'env' => $env
		] );
		// DOMPostProcessor has a FIXME about moving this to DOMUtils / Env
		$dompp = new DOMPostProcessor( $env );
		$dompp->addMetaData( $env, $doc );
	}

	/**
	 * @param string $titleStr Image title string
	 * @param array $imageOpts Array of a mix of strings or arrays,
	 *   the latter of which can signify that the value came from source.
	 *   Where,
	 *     [0] is the fully-constructed image option
	 *     [1] is the full wikitext source offset for it
	 * @param ?string &$error
	 * @return ?DOMElement
	 */
	public function renderMedia(
		string $titleStr, array $imageOpts, ?string &$error = null
	): ?DOMElement {
		$extTagName = $this->extTag->getName();

		$title = $this->makeTitle(
			$titleStr,
			$this->getSiteConfig()->canonicalNamespaceId( 'file' )
		);

		if ( $title === null || !$title->getNamespace()->isFile() ) {
			$error = "{$extTagName}_no_image";
			return null;
		}

		// FIXME: Try to confirm `file` isn't going to break WikiLink syntax.
		// See the check for 'figure' below.
		$file = $title->getPrefixedDBKey();

		$pieces = [ '[[' ];
		// Since the above two chars aren't from source, the resulting figure
		// won't have any dsr info, so we can omit an offset for the title as
		// well
		$pieces[] = $file;
		$pieces = array_merge( $pieces, $imageOpts );
		$pieces[] = ']]';

		$shiftOffset = function ( int $offset ) use ( $pieces ): ?int {
			foreach ( $pieces as $p ) {
				if ( is_string( $p ) ) {
					$offset -= strlen( $p );
					if ( $offset <= 0 ) {
						return null;
					}
				} else {
					if ( $offset <= strlen( $p[0] ) && isset( $p[1] ) ) {
						return $p[1] + $offset;
					}
					$offset -= strlen( $p[0] );
					if ( $offset <= 0 ) {
						return null;
					}
				}
			}
			return null;
		};

		$imageWt = array_reduce( $pieces, function ( $c, $p ) {
			return $c . ( is_string( $p ) ? $p : $p[0] );
		}, '' );

		$domFragment = $this->wikitextToDOM(
			$imageWt,
			[
				'parseOpts' => [
					'extTag' => $extTagName,
					'context' => 'inline',
				],
				// Create new frame, because $pieces doesn't literally appear
				// on the page, it has been hand-crafted here
				'processInNewFrame' => true,
				// Shift the DSRs in the DOM by startOffset, and strip DSRs
				// for bits which aren't the caption or file, since they
				// don't refer to actual source wikitext
				'shiftDSRFn' => function ( DomSourceRange $dsr ) use ( $shiftOffset ) {
					$start = $dsr->start === null ? null :
						   $shiftOffset( $dsr->start );
					$end = $dsr->end === null ? null :
						 $shiftOffset( $dsr->end );
					// If either offset is newly-invalid, remove entire DSR
					if ( ( $dsr->start !== null && $start === null ) ||
						 ( $dsr->end !== null && $end === null ) ) {
						return null;
					}
					return new DomSourceRange(
						$start, $end, $dsr->openWidth, $dsr->closeWidth
					);
				},
			],
			true  // sol
		);

		$thumb = $domFragment->firstChild;
		if ( !preg_match( "/^figure|span$/", $thumb->nodeName ) ) {
			$error = "{$extTagName}_invalid_image";
			return null;
		}
		DOMUtils::assertElt( $thumb );

		// Detach the $thumb since the $domFragment is going out of scope
		// See https://bugs.php.net/bug.php?id=39593
		DOMCompat::remove( $thumb );

		return $thumb;
	}

	/**
	 * @param array $modules
	 */
	public function addModules( array $modules ) {
		$this->env->addOutputProperty( 'modules', $modules );
	}

	/**
	 * @param array $modulestyles
	 */
	public function addModuleStyles( array $modulestyles ) {
		$this->env->addOutputProperty( 'modulestyles', $modulestyles );
	}

}
