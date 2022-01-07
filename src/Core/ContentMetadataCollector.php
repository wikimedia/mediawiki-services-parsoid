<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

/**
 * Interface for collecting the results of a parse.
 *
 * This class is used by Parsoid to record metainformation about a
 * particular bit of parsed content which is extracted during the
 * parse.  This includes (for example) table of contents information,
 * and lists of links/categories/templates/images present in the
 * content.  Expected cache lifetime of this parsed content is also
 * recorded here, as it is influenced by certain things which may
 * be encountered during the parse.
 *
 * In core this is implemented by ParserOutput.  Core uses
 * ParserOutput to record the rendered HTML (and rendered table of
 * contents HTML), but on the Parsoid side we're going to keep
 * rendered HTML DOM out of this interface (we use PageBundle for
 * this).
 */
interface ContentMetadataCollector {
	/*
	 * Internal implementation notes:
	 * This class was refactored out of ParserOutput in core.
	 *
	 * == Deliberately omitted ==
	 * ::get*()/::has*() and other getters
	 *   This is a builder-only interface.  This also avoids ordering
	 *   issues if/when Parsoid passes this class to sub-parses/extensions.
	 * ::setSpeculativeRevIdUsed()
	 * ::setRevisionTimestampUsed()
	 * ::setRevisionUsedSha1Base36()
	 * ::setSpeculativePageIdUsed()
	 *   T292865: these should be plumbed through direct from ParserOptions
	 *   or use the ::setOutputFlag() or addOutputData() mechanism.
	 * ::setTimestamp()
	 *   This is used by ParserCache and is a little optimization used to
	 *   show the correct 'article was last edited on blablablah' box on
	 *   page views.  Parsoid shouldn't need to worry about this; probably
	 *   part of T292865.
	 * ::addCacheMessage()
	 *   This is marked @internal in core.
	 *   Not clear yet whether Parsoid needs this.
	 * ::getText()/::setText()
	 *   T293512: rendered HTML doesn't belong in ParserOutput
	 * ::addWrapperDivClass()/::clearWrapperDivClass()
	 *   Has to do with ::getText() implementation, see above
	 * ::setTitleText()
	 *   Omited because it contains rendered HTML
	 *   (should become a method which takes a DOM tree instead?)
	 * ::setTOCHTML()
	 *   Omitted because it contains rendered HTML.
	 *   T293513 will remove this method from ParserOutput
	 * ::addOutputHook()
	 *   T292321 will remove this
	 * ::addHeadItem()
	 *   Not clear this is needed by Parsoid (but maybe some of the stuff
	 *   Parsoid adds to head could be refactored to use this interface).
	 *   Should be DOM not string data!
	 * ::addOutputPageMetadata()
	 *   OutputPage isn't a Parsoid interface, so this shouldn't be needed
	 *   by Parsoid.
	 * ::setDisplayTitle()
	 *   T293514: This desugars to calls to two other methods in
	 *   ContentOutputBuilder; callers can refactor to invoke those directly.
	 * ::unsetPageProperty()
	 *   If parse fragment A is setting a property
	 *   and parse fragment B is unsetting the property, we've introduced
	 *   an ordering dependency. We'd like to avoid that code pattern.
	 * ::resetParseStartTime()/::getTimeSinceStart()
	 *   Not needed by parsoid?
	 * ::finalizeAdaptiveCacheExpiry()
	 *   Same as above, can probably be invoked by caller of parsoid,
	 *   doesn't need to be in Parsoid library code.
	 * ::mergeInternalMetaDataFrom()
	 * ::mergeHtmlMetaDataFrom()
	 * ::mergeTrackingMetaDataFrom()
	 *   Rather than explicitly merging ContentMetadataCollectors, we'd
	 *   prefer to pass a single ContentOutputBuilder around to accumulate
	 *   results.  We're going to wait and see to what extent methods like
	 *   this are necessary.
	 * ::setNoGallery()/::setEnableOOUI()/::setNewSection()/::setHideNewSection()
	 * ::setPreventClickjacking()/::setIndexPolicy()/
	 *   Available via ::setOutputFlag() (see T292868)
	 * ::setCategories()
	 *   Doesn't seem necessary, we have ::addCategory().
	 * ::addTrackingCategory()
	 *   This was moved to Parser / the TrackingCategories service, but
	 *   perhaps it would be helpful if we had a version of this available
	 *   from SiteConfig or something.
	 * ::isLinkInternal()
	 *   T296036: Should be non-public or at least @internal?
	 *
	 * == Temporarily omitted ==
	 * ::addLink()/::addInterwikiLink()/::addTrackingCategory()
	 * ::addImage()
	 *   T296023: Takes a LinkTarget as a parameter; need alternative using a
	 *   Parsoid-available type. (eg ::addImage() takes 'Title dbKey'; see
	 *   T296037 to make it consistent)
	 *   (Does ::addInterwikiLink() really need the internal test for
	 *   $link->isExternal(), or should that be hoisted to the caller?)
	 * ::addTemplate()
	 *   T296038: See above re Title-related types.  In addition, this
	 *   interacts with user hooks.  The MediaWiki side should probably be
	 *   responsible for updating the Template dependencies not Parsoid.
	 *   OTOH, we need to return *something* like a Title back because
	 *   eventually Parsoid has to fetch the template to expand it.
	 * ::setLanguageLinks() / ::addLanguageLink()
	 *   T296019: This *should* accept an array of LinkTargets; see above re:
	 *   Title-related types.
	 * ::setTitleText()
	 *   T293514: This contains the title in HTML and is redundant with
	 *   ::setDisplayTitle()
	 * ::setSections()
	 *   T296025: Should be more structured
	 * ::setIndicator()
	 *   Probably should be 'addIndicator' for consistency.  The `content`
	 *   parameter is a string, but we'd probably want a DOM?  If it's a
	 *   DOM object we need to be able to JSON serialize and unserialize
	 *   it for ParserCache.
	 * ::addModules()/::addModuleStyles()/::addJsConfigVars()
	 *   T296123: Takes string|array argument; type should be simplified
	 *   and documentation needs to be copied over from OutputPage
	 *   (Probably should be unified with T296345)
	 *   (See https://phabricator.wikimedia.org/T272942#7605560 for
	 *   ::addJsConfigVars(), which probably should be deliberately
	 *   omitted from ContentMetadataCollector)
	 * ::addExtraCSPDefaultSrc()
	 * ::addExtraCSPStyleSrc()
	 * ::addExtraCSPScriptSrc()
	 * ::updateRuntimeAdaptiveExpiry()
	 *   T296345: export a uniform interface for accumulator methods
	 */

	/**
	 * @param string $c Category name
	 * @param string $sort Sort key
	 */
	public function addCategory( string $c, string $sort ): void;

	/**
	 * Add a warning to the output for this page.
	 * @param string $msg The localization message key for the warning
	 * @param mixed ...$args Optional arguments for the message
	 * @since 1.38
	 */
	public function addWarningMsg( string $msg, ...$args ): void;

	/**
	 * @param string $url External link URL
	 */
	public function addExternalLink( string $url );

	/**
	 * Provides a uniform interface to various boolean flags stored
	 * in the content metadata.  Flags internal to MediaWiki core should
	 * have names which are constants in ParserOutputFlags.  Extensions
	 * should use ::setExtensionData() rather than creating new flags
	 * with ::setOutputFlag() in order to prevent namespace conflicts.
	 *
	 * @param string $name A flag name
	 * @param bool $val
	 * @since 1.38
	 */
	public function setOutputFlag( string $name, bool $val = true ): void;

	/**
	 * Set a property to be stored in the page_props database table.
	 *
	 * page_props is a key value store indexed by the page ID. This allows
	 * the parser to set a property on a page which can then be quickly
	 * retrieved given the page ID or via a DB join when given the page
	 * title.
	 *
	 * page_props is also indexed by numeric value, to allow
	 * for efficient "top k" queries of pages wrt a given property.
	 *
	 * setPageProperty() is thus used to propagate properties from the parsed
	 * page to request contexts other than a page view of the currently parsed
	 * article.
	 *
	 * Some applications examples:
	 *
	 *   * To implement hidden categories, hiding pages from category listings
	 *     by storing a property.
	 *
	 * * Overriding the displayed article title
	 *     (ContentMetadataCollector::setDisplayTitle()).
	 *
	 *   * To implement image tagging, for example displaying an icon on an
	 *     image thumbnail to indicate that it is listed for deletion on
	 *     Wikimedia Commons.
	 *     This is not actually implemented, yet but would be pretty cool.
	 *
	 * @note Do not use setPageProperty() to set a property which is only used
	 * in a context where the content metadata itself is already available,
	 * for example a normal page view. There is no need to save such a property
	 * in the database since the text is already parsed. You can just hook
	 * OutputPageParserOutput and get your data out of the ParserOutput object.
	 *
	 * If you are writing an extension where you want to set a property in the
	 * parser which is used by an OutputPageParserOutput hook, you have to
	 * associate the extension data directly with the ParserOutput object.
	 * Since MediaWiki 1.21, you can use setExtensionData() to do this:
	 *
	 * @par Example:
	 * @code
	 *    $parser->getOutput()->setExtensionData( 'my_ext_foo', '...' );
	 * @endcode
	 *
	 * And then later, in OutputPageParserOutput or similar:
	 *
	 * @par Example:
	 * @code
	 *    $output->getExtensionData( 'my_ext_foo' );
	 * @endcode
	 *
	 * @note Only scalar values like numbers and strings are supported
	 * as a value. Attempt to use an object or array will
	 * not work properly with LinksUpdate.
	 *
	 * @param string $name
	 * @param int|float|string|bool|null $value
	 */
	public function setPageProperty( string $name, $value ): void;

	/**
	 * Attaches arbitrary data to this content. This can be used to
	 * store some information for later use during page output. The
	 * data will be cached along with the parsed page, but unlike data
	 * set using setPageProperty(), it is not recorded in the
	 * database.
	 *
	 * To use setExtensionData() to pass extension information from a
	 * hook inside the parser to a hook in the page output, use this
	 * in the parser hook:
	 *
	 * @par Example:
	 * @code
	 *    $parser->getOutput()->setExtensionData( 'my_ext_foo', '...' );
	 * @endcode
	 *
	 * And then later, in OutputPageParserOutput or similar:
	 *
	 * @par Example:
	 * @code
	 *    $output->getExtensionData( 'my_ext_foo' );
	 * @endcode
	 *
	 * @note Only scalar values, e.g. numbers, strings, arrays or
	 * MediaWiki\Json\JsonUnserializable instances are supported as a
	 * value. Attempt to set other class instance as a extension data
	 * will break ParserCache for the page.
	 *
	 * @param string $key The key for accessing the data. Extensions
	 *   should take care to avoid conflicts in naming keys. It is
	 *   suggested to use the extension's name as a prefix.  Keys
	 *   beginning with `mw-` are reserved for use by mediawiki core.
	 *
	 * @param mixed $value The value to set.
	 *   Setting a value to null is equivalent to removing the value.
	 *
	 * @since 1.21
	 */
	public function setExtensionData( string $key, $value ): void;

	/**
	 * Sets parser limit report data for a key
	 *
	 * The key is used as the prefix for various messages used for formatting:
	 *  - $key: The label for the field in the limit report
	 *  - $key-value-text: Message used to format the value in the "NewPP limit
	 *      report" HTML comment. If missing, uses $key-format.
	 *  - $key-value-html: Message used to format the value in the preview
	 *      limit report table. If missing, uses $key-format.
	 *  - $key-value: Message used to format the value. If missing, uses "$1".
	 *
	 * Note that all values are interpreted as wikitext, and so should be
	 * encoded with htmlspecialchars() as necessary, but should avoid complex
	 * HTML for sanity of display in the "NewPP limit report" comment.
	 *
	 * @since 1.22
	 * @param string $key Message key
	 * @param mixed $value Appropriate for Message::params()
	 */
	public function setLimitReportData( string $key, $value ): void;
}
