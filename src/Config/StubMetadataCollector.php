<?php

declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Config;

use Psr\Log\LoggerInterface;
use Psr\Log\LogLevel;
use Wikimedia\Assert\UnreachableException;
use Wikimedia\Parsoid\Core\ContentMetadataCollector;
use Wikimedia\Parsoid\Core\ContentMetadataCollectorCompat;
use Wikimedia\Parsoid\Core\ContentMetadataCollectorStringSets as CMCSS;
use Wikimedia\Parsoid\Core\LinkTarget;
use Wikimedia\Parsoid\Core\TOCData;
use Wikimedia\Parsoid\Utils\TitleValue;

/**
 * Minimal implementation of a ContentMetadataCollector which just
 * records all metadata in an array.  Used for testing or operation
 * in API mode.
 */
class StubMetadataCollector implements ContentMetadataCollector {
	use ContentMetadataCollectorCompat;

	public const LINKTYPE_CATEGORY = 'category';
	public const LINKTYPE_LANGUAGE = 'language';
	public const LINKTYPE_INTERWIKI = 'interwiki';
	public const LINKTYPE_LOCAL = 'local';
	public const LINKTYPE_MEDIA = 'media';
	public const LINKTYPE_SPECIAL = 'special';
	public const LINKTYPE_TEMPLATE = 'template';

	/** @var SiteConfig */
	private $siteConfig;

	/** @var LoggerInterface */
	private $logger;

	/** @var array<string,array> */
	private $mWarningMsgs = [];

	/** @var array */
	private $storage = [];

	/** @var string */
	private const MERGE_STRATEGY_KEY = '_parsoid-strategy_';

	/**
	 * Non-standard merge strategy to use for properties which are *not*
	 * accumulators: "write-once" means that the property should be set
	 * once (although subsequently resetting it to the same value is ok)
	 * and an error will be thrown if there is an attempt to combine
	 * multiple values.
	 *
	 * This strategy is internal to the StubMetadataCollector for now;
	 * ParserOutput implements similar semantics for many of its properties,
	 * but not (yet) in a principled or uniform way.
	 */
	private const MERGE_STRATEGY_WRITE_ONCE = 'write-once';

	/**
	 * @param SiteConfig $siteConfig Used to resolve title namespaces
	 *  and to log warnings for unsafe metadata updates
	 */
	public function __construct(
		SiteConfig $siteConfig
	) {
		$this->siteConfig = $siteConfig;
		$this->logger = $siteConfig->getLogger();
	}

	/** @inheritDoc */
	public function addCategory( $c, $sort = '' ): void {
		// Numeric strings often become an `int` when passed to addCategory()
		$this->collect(
			self::LINKTYPE_CATEGORY,
			$this->linkToString( $c ),
			$sort,
			self::MERGE_STRATEGY_WRITE_ONCE
		);
	}

	/** @inheritDoc */
	public function addWarningMsg( string $msg, ...$args ): void {
		$this->mWarningMsgs[$msg] = $args;
	}

	/** @inheritDoc */
	public function addExternalLink( string $url ): void {
		$this->collect(
			'externallinks',
			$url,
			'',
			self::MERGE_STRATEGY_WRITE_ONCE
		);
	}

	public function getExternalLinks(): array {
		return array_keys( $this->get( 'externallinks' ) );
	}

	/** @inheritDoc */
	public function setOutputFlag( string $name, bool $value = true ): void {
		$this->collect( 'outputflags', $name, (string)$value, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/** @inheritDoc */
	public function appendOutputStrings( string $name, array $value ): void {
		foreach ( $value as $v ) {
			$this->collect( 'outputstrings', $name, $v );
		}
	}

	/** @inheritDoc */
	public function setUnsortedPageProperty( string $propName, string $value = '' ): void {
		$this->collect( 'properties', $propName, $value, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/** @inheritDoc */
	public function setNumericPageProperty( string $propName, $numericValue ): void {
		if ( !is_numeric( $numericValue ) ) {
			throw new \TypeError( __METHOD__ . " with non-numeric value" );
		}
		$value = 0 + $numericValue; # cast to number
		$this->collect( 'properties', $propName, $value, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/** @inheritDoc */
	public function setExtensionData( string $key, $value ): void {
		$this->collect( 'extensiondata', $key, $value, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/** @inheritDoc */
	public function setJsConfigVar( string $key, $value ): void {
		$this->collect( 'jsconfigvars', $key, $value, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/** @inheritDoc */
	public function appendExtensionData(
		string $key,
		$value,
		string $strategy = self::MERGE_STRATEGY_UNION
	): void {
		$this->collect( 'extensiondata', $key, $value, $strategy );
	}

	/** @inheritDoc */
	public function appendJsConfigVar(
		string $key,
		string $value,
		string $strategy = self::MERGE_STRATEGY_UNION
	): void {
		$this->collect( 'jsconfigvars', $key, $value, $strategy );
	}

	/** @inheritDoc */
	public function addModules( array $modules ): void {
		$this->appendOutputStrings( CMCSS::MODULE, $modules );
	}

	/** @inheritDoc */
	public function addModuleStyles( array $moduleStyles ): void {
		$this->appendOutputStrings( CMCSS::MODULE_STYLE, $moduleStyles );
	}

	/** @inheritDoc */
	public function setLimitReportData( string $key, $value ): void {
		// XXX maybe need to JSON-encode $value
		$this->collect( 'limitreportdata', $key, $value, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/** @inheritDoc */
	public function setTOCData( TOCData $tocData ): void {
		$this->collect( 'tocdata', '', $tocData, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/** @inheritDoc */
	public function addLink( LinkTarget $link, $id = null ): void {
		# Fragments are stripped when collecting.
		$link = $link->createFragmentTarget( '' );
		$type = self::LINKTYPE_LOCAL;

		if ( $link->isExternal() ) {
			$type = self::LINKTYPE_INTERWIKI;
		} elseif ( $link->inNamespace( -1 ) ) {
			$type = self::LINKTYPE_SPECIAL;
		}

		if ( $type === self::LINKTYPE_LOCAL && $link->getDbkey() === '' ) {
			// Don't record self links - [[#Foo]]
			return;
		}
		$this->collect(
			$type,
			$this->linkToString( $link ),
			'',
			self::MERGE_STRATEGY_WRITE_ONCE
		);
	}

	/** @inheritDoc */
	public function addImage( LinkTarget $link, $timestamp = null, $sha1 = null ): void {
		# Fragments are stripped when collecting.
		$link = $link->createFragmentTarget( '' );
		$this->collect(
			self::LINKTYPE_MEDIA,
			$this->linkToString( $link ),
			'',
			self::MERGE_STRATEGY_WRITE_ONCE
		);
	}

	/** @inheritDoc */
	public function addLanguageLink( LinkTarget $lt ): void {
		# Fragments are *not* stripped from language links.
		# Language links are deduplicated by the interwiki prefix

		# Note that, unlike some other types of collected metadata,
		# language links are 'first wins' and the subsequent entries
		# for the same language are ignored.
		if ( $this->get( self::LINKTYPE_LANGUAGE, $lt->getInterwiki(), self::MERGE_STRATEGY_WRITE_ONCE ) !== null ) {
			return;
		}

		$this->collect(
			self::LINKTYPE_LANGUAGE,
			$lt->getInterwiki(),
			$this->linkToString( $lt ),
			self::MERGE_STRATEGY_WRITE_ONCE
		);
	}

	/**
	 * Add a dependency on the given template.
	 * @param LinkTarget $link
	 * @param int $page_id
	 * @param int $rev_id
	 */
	public function addTemplate( LinkTarget $link, int $page_id, int $rev_id ): void {
		# Fragments are stripped when collecting.
		$link = $link->createFragmentTarget( '' );
		// XXX should store the page_id and rev_id
		$this->collect(
			self::LINKTYPE_TEMPLATE,
			$this->linkToString( $link ),
			'',
			self::MERGE_STRATEGY_WRITE_ONCE
		);
	}

	/**
	 * @see ParserOutput::getLinkList()
	 * @param string $linkType A link type, which should be a constant from
	 *  this class
	 * @return list<array{link:LinkTarget,pageid?:int,revid?:int,sort?:string,time?:string|false,sha1?:string|false}>
	 */
	public function getLinkList( string $linkType ): array {
		$result = [];
		switch ( $linkType ) {
			case self::LINKTYPE_CATEGORY:
				foreach ( $this->get( $linkType ) as $link => $sort ) {
					$result[] = [
						'link' => $this->stringToLink( (string)$link ),
						'sort' => $sort,
					];
				}
				break;
			case self::LINKTYPE_LANGUAGE:
				foreach ( $this->get( $linkType ) as $lang => $link ) {
					$result[] = [
						'link' => $this->stringToLink( $link ),
					];
				}
				break;
			case self::LINKTYPE_INTERWIKI:
			case self::LINKTYPE_LOCAL:
			case self::LINKTYPE_MEDIA:
			case self::LINKTYPE_SPECIAL:
			case self::LINKTYPE_TEMPLATE:
				foreach ( $this->get( $linkType ) as $link => $ignore ) {
					$result[] = [
						'link' => $this->stringToLink( (string)$link ),
					];
				}
				break;
			default:
				throw new UnreachableException( "Bad link type: $linkType" );
		}
		return $result;
	}

	/**
	 * Unified internal implementation of metadata collection.
	 * @param string $which Internal string identifying the type of metadata.
	 * @param string $key Key for storage (or '' if this is not relevant)
	 * @param mixed $value Value to store
	 * @param string $strategy "union" or "write-once"
	 */
	private function collect(
		string $which, string $key, $value,
		string $strategy = self::MERGE_STRATEGY_UNION
	): void {
		if ( !array_key_exists( $which, $this->storage ) ) {
			$this->storage[$which] = [];
		}
		if ( !array_key_exists( $key, $this->storage[$which] ) ) {
			$this->storage[$which][$key] = [ self::MERGE_STRATEGY_KEY => $strategy ];
			if ( $strategy === self::MERGE_STRATEGY_WRITE_ONCE ) {
				$this->storage[$which][$key]['value'] = $value;
				return;
			}
		}
		if ( $this->storage[$which][$key][self::MERGE_STRATEGY_KEY] !== $strategy ) {
			$this->logger->log(
				LogLevel::WARNING,
				"Conflicting strategies for $which $key"
			);
			// Destructive update for compatibility; this is deprecated!
			unset( $this->storage[$which][$key] );
			$this->collect( $which, $key, $value, $strategy );
			return;
		}
		if ( $strategy === self::MERGE_STRATEGY_WRITE_ONCE ) {
			if ( ( $this->storage[$which][$key]['value'] ?? null ) === $value ) {
				return; // already exists with the desired value
			}
			$this->logger->log(
				LogLevel::WARNING,
				"Multiple writes to a write-once: $which $key"
			);
			// Destructive update for compatibility; this is deprecated!
			unset( $this->storage[$which][$key] );
			$this->collect( $which, $key, $value, $strategy );
			return;
		} elseif ( $strategy === self::MERGE_STRATEGY_UNION ) {
			if ( !( is_string( $value ) || is_int( $value ) ) ) {
				throw new \InvalidArgumentException( "Bad value type for $key: " . get_debug_type( $value ) );
			}
			$this->storage[$which][$key][$value] = true;
			return;
		} else {
			throw new \InvalidArgumentException( "Unknown strategy: $strategy" );
		}
	}

	/**
	 * Retrieve values from the collector.
	 * @param string $which Internal string identifying the type of metadata.
	 * @param string|null $key Key for storage (or '' if this is not relevant)
	 * @param string $defaultStrategy Determines whether to return an empty
	 *  array or null for a missing $key
	 * @return mixed
	 */
	private function get( string $which, ?string $key = null, string $defaultStrategy = self::MERGE_STRATEGY_UNION ) {
		if ( $key !== null ) {
			$result = ( $this->storage[$which] ?? [] )[$key] ?? [];
			$strategy = $result[self::MERGE_STRATEGY_KEY] ?? $defaultStrategy;
			unset( $result[self::MERGE_STRATEGY_KEY] );
			if ( $strategy === self::MERGE_STRATEGY_WRITE_ONCE ) {
				return $result['value'] ?? null;
			} else {
				return array_keys( $result );
			}
		}
		$result = [];
		foreach ( ( $this->storage[$which] ?? [] ) as $key => $ignore ) {
			$result[$key] = $this->get( $which, (string)$key );
		}
		return $result;
	}

	// @internal introspection methods

	/** @return string[] */
	public function getModules(): array {
		return $this->get( 'outputstrings', CMCSS::MODULE );
	}

	/** @return string[] */
	public function getModuleStyles(): array {
		return $this->get( 'outputstrings', CMCSS::MODULE_STYLE );
	}

	/** @return string[] */
	public function getJsConfigVars(): array {
		// This is somewhat unusual, in that we expose the 'set' represenation
		// as $key => true, instead of just returning array_keys().
		$result = $this->storage['jsconfigvars'] ?? [];
		foreach ( $result as $key => &$value ) {
			$strategy = $value[self::MERGE_STRATEGY_KEY] ?? null;
			unset( $value[self::MERGE_STRATEGY_KEY] );
			if ( $strategy === self::MERGE_STRATEGY_WRITE_ONCE ) {
				$value = array_keys( $value )[0];
			}
		}
		return $result;
	}

	/** @return list<string> */
	public function getCategoryNames(): array {
		return array_map(
			fn ( $item ) => $item['link']->getDBkey(),
			$this->getLinkList( self::LINKTYPE_CATEGORY )
		);
	}

	/**
	 * @param string $name Category name
	 * @return ?string Sort key
	 */
	public function getCategorySortKey( string $name ): ?string {
		$tv = TitleValue::tryNew(
			14, // NS_CATEGORY
			$name
		);
		return $this->get(
			self::LINKTYPE_CATEGORY,
			$this->linkToString( $tv ),
			self::MERGE_STRATEGY_WRITE_ONCE
		);
	}

	/**
	 * @param string $name
	 * @return ?string
	 */
	public function getPageProperty( string $name ): ?string {
		return $this->get( 'properties', $name, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/**
	 * Return the collected extension data under the given key.
	 * @param string $key
	 * @return mixed|null
	 */
	public function getExtensionData( string $key ) {
		return $this->get( 'extensiondata', $key, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/**
	 * Return the active output flags.
	 * @return string[]
	 */
	public function getOutputFlags() {
		$result = [];
		foreach ( $this->get( 'outputflags', null ) as $key => $value ) {
			if ( $value ) {
				$result[] = $key;
			}
		}
		return $result;
	}

	/**
	 * Return the collected TOC data, or null if no TOC data was collected.
	 * @return ?TOCData
	 */
	public function getTOCData(): ?TOCData {
		return $this->get( 'tocdata', '', self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/**
	 * Set the content for an indicator.
	 * @param string $name
	 * @param string $content
	 */
	public function setIndicator( $name, $content ): void {
		$this->collect( 'indicators', $name, $content, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/**
	 * Return a "name" => "content-id" mapping of recorded indicators
	 * @return array
	 */
	public function getIndicators(): array {
		return $this->get( 'indicators' );
	}

	// helper functions for recording LinkTarget objects

	/**
	 * Convert a LinkTarget to a string for storing in the collected metadata.
	 * @param LinkTarget $lt
	 * @return string
	 */
	private function linkToString( LinkTarget $lt ): string {
		return implode( '#', [
			(string)$lt->getNamespace(),
			$lt->getDBkey(),
			$lt->getInterwiki(),
			$lt->getFragment(),
		] );
	}

	/**
	 * Convert a string back into a LinkTarget for retrieval from the
	 * collected metadata.
	 * @param string $s
	 * @return LinkTarget
	 */
	private function stringToLink( string $s ): LinkTarget {
		[ $namespace, $dbkey, $interwiki, $fragment ] = explode( '#', $s, 4 );
		return TitleValue::tryNew( (int)$namespace, $dbkey, $fragment, $interwiki );
	}
}
