// Progressive enhancement for JS core - define things that are scheduled to
// appear in the standard anyway.


/**
 * @class CoreUpgradeArray
 */
if ( !Array.prototype.last ) {

	/**
	 * @property {Mixed} last
	 */
	Object.defineProperty( Array.prototype, 'last', {
		value: function () {
			return this[this.length - 1];
		}
	});
}

/**
 * @class Array
 * @mixins CoreUpgradeArray
 */
