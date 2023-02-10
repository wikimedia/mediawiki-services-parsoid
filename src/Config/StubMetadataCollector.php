<?php

declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Config;

use Psr\Log\LoggerInterface;
use Psr\Log\LogLevel;
use Psr\Log\NullLogger;
use Wikimedia\Parsoid\Core\ContentMetadataCollector;
use Wikimedia\Parsoid\Core\ContentMetadataCollectorCompat;
use Wikimedia\Parsoid\Core\TOCData;

/**
 * Minimal implementation of a ContentMetadataCollector which just
 * records all metadata in an array.  Used for testing or operation
 * in API mode.
 */
class StubMetadataCollector implements ContentMetadataCollector {
	use ContentMetadataCollectorCompat;

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
	 * @param ?LoggerInterface $logger Optional logger to log warnings
	 * for unsafe metadata updates
	 */
	public function __construct( ?LoggerInterface $logger = null ) {
		$this->logger = $logger ?? new NullLogger;
	}

	/** @inheritDoc */
	public function addCategory( $c, $sort = '' ): void {
		// Numeric strings often become an `int` when passed to addCategory()
		$this->collect( 'categories', (string)$c, $sort, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/** @inheritDoc */
	public function addWarningMsg( string $msg, ...$args ): void {
		$this->mWarningMsgs[$msg] = $args;
	}

	/** @inheritDoc */
	public function addExternalLink( string $url ): void {
		$this->collect( 'externallinks', '', $url );
	}

	/** @inheritDoc */
	public function setOutputFlag( string $name, bool $value = true ): void {
		$this->collect( 'outputflags', $name, (string)$value, self::MERGE_STRATEGY_WRITE_ONCE );
	}

	/** @inheritDoc */
	public function setPageProperty( string $name, $value ): void {
		$this->collect( 'properties', $name, $value, self::MERGE_STRATEGY_WRITE_ONCE );
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
		foreach ( $modules as $module ) {
			$this->collect( 'modules', '', $module );
		}
	}

	/** @inheritDoc */
	public function addModuleStyles( array $moduleStyles ): void {
		foreach ( $moduleStyles as $style ) {
			$this->collect( 'modulestyles', '', $style );
		}
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
				throw new \Exception( "Bad value type for $key: " . gettype( $value ) );
			}
			$this->storage[$which][$key][$value] = true;
			return;
		} else {
			throw new \Exception( "Unknown strategy: $strategy" );
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
			$result[$key] = $this->get( $which, $key );
		}
		return $result;
	}

	// @internal introspection methods

	/** @return string[] */
	public function getModules(): array {
		return $this->get( 'modules', '' );
	}

	/** @return string[] */
	public function getModuleStyles(): array {
		return $this->get( 'modulestyles', '' );
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

	/** @return array<string,string> */
	public function getCategories(): array {
		return $this->get( 'categories' );
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
}
