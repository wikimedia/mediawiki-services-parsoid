<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

/**
 * Helper trait for implementations of ContentMetadataCollector.
 *
 * This trait is ideally empty.  However, all implementations of
 * ContentMetadataCollector should `use` it.  Then, when a method is
 * changed in the ContentMetadataCollector implementation, compatibility
 * code can be temporarily added to this trait in order to facilitate
 * migration.
 *
 * For example, suppose that the method `getFoo()` in ContentMetadataCollector`
 * was renamed to `getBar()`.  Before, third-party code contains:
 * ```
 * class MyCollector implements ContentMetadataCollector {
 *   use ContentMetadataCollectorCompat;
 *
 *   public function getFoo() { ... }
 * }
 * ```
 * When the method is renamed in the `ContentMetadataCollector` interface
 * we then add the following to `ContentMetadataCollectorCompat`:
 * ```
 * trait ContentMetadataCollectorCompat {
 *   public function getBar() {
 *     return $this->getFoo();
 *   }
 * }
 * ```
 *
 * This prevents `MyCollector` from failing to implement
 * `ContentMetadataCollector` when Parsoid is upgraded to the latest version.
 * Over time, `MyCollector` will rename the method in its own implementation
 * and that will override the default implementation inherited from the
 * `ContentMetadataCollectorCompat` class.  Then eventually the
 * compatibility method can be removed from this trait and we're back
 * where we started.
 *
 * Similarly, if we want to collect some new type of metadata, the
 * collection method can be added to `ContentMetadataCollector` at the
 * same time a default implementation is added to
 * `ContentMetadataCollectorCompat`; again ensuring that we don't
 * unnecessarily break classes which implement
 * `ContentMetadataCollector`.  The default implementation could do
 * nothing, effectively ignoring the collection request, or it could
 * record portions of the metadata using other collection methods.
 */
trait ContentMetadataCollectorCompat {
	/* This trait is empty, in an ideal world. */

	/**
	 * Retrofit new method into existing (legacy) interface
	 * till implementations support this on their own.
	 * For now, nothing to do here.
	 *
	 * @param TOCData $tocData
	 */
	public function setTOCData( TOCData $tocData ): void {
		/* Nothing to do here; in theory we'd call ParserOutput::setSections()
		 * but that interface was never added to ContentMetadataCollector. */
	}
}
