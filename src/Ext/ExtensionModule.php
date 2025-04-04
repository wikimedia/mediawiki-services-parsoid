<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

/**
 * A Parsoid native extension module.  This bundles up the
 * configuration for a number of different ExtensionTagHandlers,
 * ContentModelHandlers, FragmentHandlers, and DomProcessors into one
 * registered object.  The only method required is `getConfig`.
 *
 * An ExtensionModule can be created on-demand from configuration data
 * specified in extension.json; see SiteConfig::registerExtensionModule()
 * and
 * https://www.mediawiki.org/wiki/Manual:Extension.json/Schema#ParsoidModules
 *
 * Implementing an ExtensionModule should only be done by Parsoid-internal
 * extensions.  If you are implementing a Parsoid module in an extension
 * and have an `extension.json`, you should use that to specify your
 * module configuration.
 */
interface ExtensionModule {

	/**
	 * Return information about this extension module.
	 *
	 * The structure of the return value is enforced by
	 * `moduleconfig.schema.json`, in this directory.
	 *
	 * @see https://www.mediawiki.org/wiki/Parsoid/Internals/Module_Configuration_Schema
	 * @return array{name:string}
	 */
	public function getConfig(): array;

}
