'use strict';

const ParsoidExtApi = module.parent.parent.parent.require('./extapi.js').versionCheck('^0.11.0');
const { ContentUtils, Sanitizer } = ParsoidExtApi;

const RefGroup = require('./RefGroup.js');

/**
 * @class
 */
class ReferencesData {
	constructor(env) {
		this.index = 0;
		this.env = env;
		this.refGroups = new Map();
	}

	makeValidIdAttr(val) {
		// Looks like Cite.php doesn't try to fix ids that already have
		// a "_" in them. Ex: name="a b" and name="a_b" are considered
		// identical. Not sure if this is a feature or a bug.
		// It also considers entities equal to their encoding
		// (i.e. '&' === '&amp;'), which is done:
		//  in PHP: Sanitizer#decodeTagAttributes and
		//  in Parsoid: ExtensionHandler#normalizeExtOptions
		return Sanitizer.escapeIdForAttribute(val);
	}

	getRefGroup(groupName, allocIfMissing) {
		groupName = groupName || '';
		if (!this.refGroups.has(groupName) && allocIfMissing) {
			this.refGroups.set(groupName, new RefGroup(groupName));
		}
		return this.refGroups.get(groupName);
	}

	removeRefGroup(groupName) {
		if (groupName !== null && groupName !== undefined) {
			// '' is a valid group (the default group)
			this.refGroups.delete(groupName);
		}
	}

	add(env, groupName, refName, about, skipLinkback) {
		var group = this.getRefGroup(groupName, true);
		refName = this.makeValidIdAttr(refName);
		const hasRefName = refName.length > 0;

		var ref;
		if (hasRefName && group.indexByName.has(refName)) {
			ref = group.indexByName.get(refName);
			if (ref.content && !ref.hasMultiples) {
				ref.hasMultiples = true;
				// Use the non-pp version here since we've already stored attribs
				// before putting them in the map.
				ref.cachedHtml = ContentUtils.toXML(env.fragmentMap.get(ref.content)[0], { innerXML: true });
			}
		} else {
			// The ids produced Cite.php have some particulars:
			// Simple refs get 'cite_ref-' + index
			// Refs with names get 'cite_ref-' + name + '_' + index + (backlink num || 0)
			// Notes (references) whose ref doesn't have a name are 'cite_note-' + index
			// Notes whose ref has a name are 'cite_note-' + name + '-' + index
			var n = this.index;
			var refKey = (1 + n) + '';
			var refIdBase = 'cite_ref-' + (hasRefName ? refName + '_' + refKey : refKey);
			var noteId = 'cite_note-' + (hasRefName ? refName + '-' + refKey : refKey);

			// bump index
			this.index += 1;

			ref = {
				about: about,
				content: null,
				dir: '',
				group: group.name,
				groupIndex: group.refs.length + 1,
				index: n,
				key: refIdBase,
				id: (hasRefName ? refIdBase + '-0' : refIdBase),
				linkbacks: [],
				name: refName,
				target: noteId,
				hasMultiples: false,
				// Just used for comparison when we have multiples
				cachedHtml: '',
			};
			group.refs.push(ref);
			if (refName) {
				group.indexByName.set(refName, ref);
			}
		}

		if (!skipLinkback) {
			ref.linkbacks.push(ref.key + '-' + ref.linkbacks.length);
		}
		return ref;
	}
}

module.exports = ReferencesData;
